#!/usr/bin/env python3
"""Unit tests for the shared toolchain bootstrap (#1941).

`toolchains/_shared/aee-toolchain` is the piece that decides, per invocation,
WHICH version applies and WHERE the download is cached — the whole bootstrap
model rests on it. Driving it against a real `mise` would need a container and
a JDK download, so this drives it against a **stub** `mise` on PATH that
records its argv and its inherited environment. That makes the decisions
testable on the fast CI lane:

  * a project pin is found by walking up from the working directory, and the
    cache then lives under the agent's workspace (survives a respawn, isolated
    per agent);
  * no pin falls back to the image baseline, and with no baseline either it is
    a NAMED error rather than `mvn: command not found` (AC9);
  * the warm path does not run an install, the cold path does;
  * the shim directory is stripped from PATH before handing off, so a tool the
    version manager cannot resolve fails instead of recursing into this script
    forever.

The live end of the story — a real JDK, a real `mvn test`, the measured cold /
warm cost — is `verify-toolchain.sh`, which needs a container runtime.

Run:  python3 -m unittest toolchains/_shared/test_aee_toolchain.py
"""
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SHARED = Path(__file__).resolve().parent
CLI = SHARED / "aee-toolchain"
JVM = SHARED.parent / "jvm"

# Records every call as `<subcommand> <args>` and the environment that mattered,
# so a test can assert both WHAT was asked of the version manager and WITH
# WHICH resolution. `which` succeeds only once an install has run, unless the
# test pre-arms it — that is how the warm and cold paths are told apart.
STUB_MISE = textwrap.dedent(
    """\
    #!/bin/sh
    log="$STUB_LOG"
    printf '%s\\n' "argv: $*" >> "$log"
    printf 'env: MISE_DATA_DIR=%s\\n' "${MISE_DATA_DIR:-}" >> "$log"
    printf 'env: MISE_CACHE_DIR=%s\\n' "${MISE_CACHE_DIR:-}" >> "$log"
    printf 'env: MISE_GLOBAL_CONFIG_FILE=%s\\n' "${MISE_GLOBAL_CONFIG_FILE:-}" >> "$log"
    printf 'env: PATH=%s\\n' "$PATH" >> "$log"
    printf 'env: MAVEN_ARGS=%s\\n' "${MAVEN_ARGS:-}" >> "$log"
    case "${1:-}" in
      --version) echo "stub-mise 0.0.0" ;;
      which)
        [ "${STUB_WHICH_NEVER:-0}" = "1" ] && exit 1
        if [ -f "$STUB_STATE/installed" ] || [ "${STUB_WHICH_OK:-0}" = "1" ]; then
          echo "/stub/installs/$2"; exit 0
        fi
        exit 1 ;;
      install) touch "$STUB_STATE/installed"; exit "${STUB_INSTALL_RC:-0}" ;;
      exec)
        shift
        [ "${1:-}" = "--" ] && shift
        printf 'ran: %s\\n' "$*" >> "$log"
        echo "RAN $*" ;;
      *) echo "stub-mise: unhandled $*" >&2; exit 9 ;;
    esac
    """
)


class ToolchainCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workspace = self.root / "workspace"
        self.project = self.workspace / "repo" / "module"
        self.project.mkdir(parents=True)
        self.state = self.root / "state"
        self.state.mkdir()
        self.log = self.root / "calls.log"
        self.log.write_text("")

        self.bin = self.root / "stubbin"
        self.bin.mkdir()
        stub = self.bin / "mise"
        stub.write_text(STUB_MISE)
        stub.chmod(0o755)

        # The image-side baseline, present only when a test asks for it.
        self.baseline = self.root / "baseline"

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **over):
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HOME": str(self.root),
            "AEE_WORKSPACE": str(self.workspace),
            "AEE_TOOLCHAIN_MISE": str(self.bin / "mise"),
            # No variant env file by default: each test declares exactly the
            # variant configuration it is about.
            "AEE_TOOLCHAIN_ENV_FILE": str(self.root / "absent.env"),
            "AEE_TOOLCHAIN_ID": "test",
            "AEE_TOOLCHAIN_PIN_FILES": ".mise.toml .tool-versions",
            "AEE_TOOLCHAIN_SHIMS": "java mvn",
            "AEE_TOOLCHAIN_SHIM_DIR": "/opt/aee/toolchain-bin",
            "AEE_TOOLCHAIN_BASELINE": "",
            "AEE_TOOLCHAIN_BASELINE_DATA": "",
            "AEE_TOOLCHAIN_ALT_PINS": ".sdkmanrc",
            "AEE_TOOLCHAIN_EXTRA_ENV": "",
            "STUB_LOG": str(self.log),
            "STUB_STATE": str(self.state),
        }
        for key, value in over.items():
            if value is None:
                env.pop(key, None)   # an explicit None means "not set at all"
            else:
                env[key] = value
        return env

    def run_cli(self, args, cwd=None, argv0=None, **over):
        # Invoked through `sh <script>` (or a symlink, for the shim cases) since
        # the repo tree does not guarantee the exec bit.
        exe = argv0 or str(CLI)
        proc = subprocess.run(
            ["sh", exe, *args],
            cwd=str(cwd or self.project),
            env=self.env(**over),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return proc

    def calls(self):
        return self.log.read_text()

    def with_baseline(self):
        self.baseline.mkdir(exist_ok=True)
        (self.baseline / "config.toml").write_text('[tools]\njava = "temurin-21"\n')
        return {
            "AEE_TOOLCHAIN_BASELINE": "java temurin-21",
            "AEE_TOOLCHAIN_BASELINE_DATA": str(self.baseline),
            "AEE_TOOLCHAIN_BASELINE_CONFIG": str(self.baseline / "config.toml"),
        }

    def pin(self, where=None, body='[tools]\njava = "temurin-17"\n'):
        target = (where or self.workspace / "repo") / ".mise.toml"
        target.write_text(body)
        return target

    # ── discovery / contract ────────────────────────────────────────────────

    def test_help_is_stdout_and_exit_zero(self):
        for args in (["--help"], ["-h"], ["help"], []):
            p = self.run_cli(args)
            self.assertEqual(p.returncode, 0, f"{args}: {p.stderr}")
            self.assertIn("aee-toolchain", p.stdout)
            self.assertIn("pin the version by committing", p.stdout.lower())

    def test_unknown_subcommand_is_a_usage_error(self):
        p = self.run_cli(["frobnicate"])
        self.assertEqual(p.returncode, 2)
        self.assertIn("unknown subcommand", p.stderr)

    def test_exec_without_a_tool_is_a_usage_error(self):
        p = self.run_cli(["exec"])
        self.assertEqual(p.returncode, 2)

    # ── AC9: nothing pinned ─────────────────────────────────────────────────

    def test_no_pin_and_no_baseline_is_a_named_error(self):
        p = self.run_cli(["exec", "mvn", "-v"])
        self.assertEqual(p.returncode, 1)
        self.assertIn("no toolchain version pinned", p.stderr)
        self.assertIn(".mise.toml", p.stderr)
        self.assertIn("ships no baseline", p.stderr)
        # The point of AC9: the version manager is never even reached, so the
        # agent cannot see a bare "command not found".
        self.assertEqual(self.calls(), "")

    def test_a_pin_for_another_version_manager_is_named_in_the_error(self):
        (self.workspace / "repo" / ".sdkmanrc").write_text("java=21.0.5-tem\n")
        p = self.run_cli(["exec", "mvn", "-v"])
        self.assertEqual(p.returncode, 1)
        self.assertIn(".sdkmanrc", p.stderr)
        self.assertIn("does not read", p.stderr)

    def test_no_pin_with_a_baseline_uses_the_image_side_install(self):
        p = self.run_cli(["exec", "java", "-version"], STUB_WHICH_OK="1", **self.with_baseline())
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(f"env: MISE_DATA_DIR={self.baseline}", self.calls())
        # An unpinned project must not trigger an install: the baseline is
        # already in the image, and a write into it would fail anyway.
        self.assertNotIn("argv: install", self.calls())

    # ── the pin, and where the cache goes ───────────────────────────────────

    def test_the_pin_is_found_by_walking_up_from_the_working_directory(self):
        self.pin()  # at <workspace>/repo, invoked from <workspace>/repo/module
        p = self.run_cli(["doctor"], STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("version pin: " + str(self.workspace / "repo" / ".mise.toml"), p.stdout)

    def test_a_module_can_pin_over_its_monorepo_root(self):
        self.pin()
        self.pin(where=self.project, body='[tools]\njava = "temurin-21"\n')
        p = self.run_cli(["doctor"], STUB_WHICH_OK="1")
        self.assertIn("version pin: " + str(self.project / ".mise.toml"), p.stdout)

    def test_a_pinned_project_caches_under_the_agent_workspace(self):
        self.pin()
        p = self.run_cli(["exec", "mvn", "test"], STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        expected = self.workspace / ".aee-toolchain" / "mise"
        self.assertIn(f"env: MISE_DATA_DIR={expected}", self.calls())
        self.assertIn(f"env: MISE_CACHE_DIR={self.workspace / '.aee-toolchain' / 'cache'}", self.calls())
        self.assertTrue((self.workspace / ".aee-toolchain" / "cache").is_dir())

    def test_a_pinned_project_is_never_widened_by_an_image_side_global_config(self):
        # "I pinned 17 and got 21" is the failure this prevents: with a
        # baseline config still in scope, mise would merge it in.
        self.pin()
        self.run_cli(["exec", "mvn", "test"], STUB_WHICH_OK="1", **self.with_baseline())
        for line in self.calls().splitlines():
            if line.startswith("env: MISE_GLOBAL_CONFIG_FILE="):
                value = line.split("=", 1)[1]
                self.assertNotEqual(value, str(self.baseline / "config.toml"))
                self.assertFalse(os.path.exists(value), "the global config must not resolve")

    def test_the_workspace_falls_back_to_the_agent_id_form(self):
        p = self.run_cli(["doctor"], AEE_WORKSPACE=None, AGENT_ID="team-x-dev")
        self.assertIn("/workspace/agents/team-x-dev", p.stdout)

    # ── warm vs cold ────────────────────────────────────────────────────────

    def test_the_warm_path_does_not_run_an_install(self):
        self.pin()
        p = self.run_cli(["exec", "mvn", "test"], STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        calls = [l for l in self.calls().splitlines() if l.startswith("argv:")]
        self.assertNotIn("argv: install", calls)
        self.assertIn("ran: mvn test", self.calls())

    def test_the_cold_path_installs_the_pinned_versions_then_runs(self):
        self.pin()
        p = self.run_cli(["exec", "mvn", "test"])  # `which` fails until install ran
        self.assertEqual(p.returncode, 0, p.stderr)
        calls = [l for l in self.calls().splitlines() if l.startswith("argv:")]
        self.assertEqual(calls[0], "argv: which mvn")
        self.assertIn("argv: install", calls)
        self.assertIn("ran: mvn test", self.calls())

    def test_a_failing_install_names_the_pin_file(self):
        pin = self.pin()
        p = self.run_cli(["exec", "mvn", "test"], STUB_INSTALL_RC="7")
        self.assertEqual(p.returncode, 1)
        self.assertIn(str(pin), p.stderr)

    def test_a_tool_the_pin_does_not_provide_is_a_named_error(self):
        # Maven missing from a config that pins only java: the actionable answer
        # is "add it to the pin", not "mvn: command not found".
        pin = self.pin()
        p = self.run_cli(["exec", "mvn", "test"], STUB_WHICH_NEVER="1")
        self.assertEqual(p.returncode, 1, p.stdout)
        self.assertIn(str(pin), p.stderr)
        self.assertIn("mise use", p.stderr)

    # ── the shims ───────────────────────────────────────────────────────────

    def test_invoked_under_a_tool_name_it_behaves_as_that_tool(self):
        self.pin()
        shim = self.root / "mvn"
        shim.symlink_to(CLI)
        p = self.run_cli(["-B", "test"], argv0=str(shim), STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("ran: mvn -B test", self.calls())

    def test_the_shim_directory_is_stripped_before_handing_off(self):
        # Without this, a tool the version manager cannot resolve falls through
        # to a PATH lookup, finds this very script under that name, and
        # recurses until the process dies.
        self.pin()
        shim_dir = self.root / "shims"
        shim_dir.mkdir()
        (shim_dir / "mvn").symlink_to(CLI)
        p = self.run_cli(
            ["exec", "mvn", "test"],
            STUB_WHICH_OK="1",
            PATH=f"{shim_dir}:{self.bin}:/usr/bin:/bin",
            AEE_TOOLCHAIN_SHIM_DIR=str(shim_dir),
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        for line in self.calls().splitlines():
            if line.startswith("env: PATH="):
                self.assertNotIn(str(shim_dir), line.split("=", 1)[1])

    def test_the_mise_shim_passes_through_with_the_resolved_environment(self):
        self.pin()
        shim = self.root / "mise"
        shim.symlink_to(CLI)
        p = self.run_cli(["--version"], argv0=str(shim), STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("stub-mise", p.stdout)
        self.assertIn(f"env: MISE_DATA_DIR={self.workspace / '.aee-toolchain' / 'mise'}", self.calls())

    # ── the variant's own configuration ─────────────────────────────────────

    def test_the_variant_env_file_is_what_makes_this_generic(self):
        env_file = self.root / "variant.env"
        env_file.write_text(
            'AEE_TOOLCHAIN_ID=dotnet\n'
            'AEE_TOOLCHAIN_PIN_FILES=".mise.toml global.json"\n'
            'AEE_TOOLCHAIN_SHIMS="dotnet"\n'
        )
        (self.workspace / "repo" / "global.json").write_text("{}\n")
        p = self.run_cli(["doctor"], AEE_TOOLCHAIN_ENV_FILE=str(env_file), STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("toolchain:   dotnet", p.stdout)
        self.assertIn("global.json", p.stdout)

    def test_the_jvm_variant_redirects_mavens_local_repository_into_the_workspace(self):
        # Otherwise only the JDK survives a respawn and the whole dependency
        # tree is re-downloaded on every restart (AC8).
        self.pin()
        p = self.run_cli(
            ["exec", "mvn", "test"],
            STUB_WHICH_OK="1",
            AEE_TOOLCHAIN_EXTRA_ENV=str(JVM / "cache-env.sh"),
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        root = self.workspace / ".aee-toolchain"
        self.assertIn(f"env: MAVEN_ARGS=-Dmaven.repo.local={root}/m2/repository", self.calls())

    def test_a_settings_xml_dropped_in_the_cache_root_is_picked_up(self):
        # The documented drop point for an internal Nexus mirror (AC10).
        self.pin()
        m2 = self.workspace / ".aee-toolchain" / "m2"
        m2.mkdir(parents=True)
        (m2 / "settings.xml").write_text("<settings/>")
        self.run_cli(
            ["exec", "mvn", "test"],
            STUB_WHICH_OK="1",
            AEE_TOOLCHAIN_EXTRA_ENV=str(JVM / "cache-env.sh"),
        )
        self.assertIn(f"-s {m2}/settings.xml", self.calls())

    def test_env_prints_export_lines_a_human_can_paste(self):
        self.pin()
        p = self.run_cli(["env"])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("export MISE_DATA_DIR=", p.stdout)
        self.assertIn("export MISE_CACHE_DIR=", p.stdout)

    def test_run_applies_the_toolchain_to_a_whole_command(self):
        # For a repository's own ./mvnw or a Makefile, which resolve java
        # through JAVA_HOME rather than through PATH.
        self.pin()
        p = self.run_cli(["run", "./mvnw", "verify"], STUB_WHICH_OK="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("ran: ./mvnw verify", self.calls())

    def test_doctor_reports_the_missing_manager_instead_of_pretending(self):
        p = self.run_cli(["doctor"], AEE_TOOLCHAIN_MISE=str(self.root / "nope"),
                         PATH="/usr/bin:/bin")
        self.assertEqual(p.returncode, 1)
        self.assertIn("MISSING", p.stdout)


class VariantManifestTest(unittest.TestCase):
    """The shipped variant must stay consistent with itself."""

    def test_every_shim_the_variant_declares_is_symlinked_by_its_dockerfile(self):
        env = (JVM / "toolchain.env").read_text()
        dockerfile = (JVM / "Dockerfile").read_text()
        self.assertIn("AEE_TOOLCHAIN_SHIMS=", env)
        # The Dockerfile must derive the symlinks from the SAME list, not
        # restate it — a restated list is what drifts.
        self.assertIn("$AEE_TOOLCHAIN_SHIMS", dockerfile)

    def test_the_variant_derives_from_the_published_agent_image(self):
        dockerfile = (JVM / "Dockerfile").read_text()
        self.assertIn("ARG AGENT_BASE_IMAGE=as-agent:latest", dockerfile)
        self.assertIn("FROM ${AGENT_BASE_IMAGE}", dockerfile)
        self.assertNotIn("python:3.12-slim", dockerfile, "a variant must not re-implement aee-base")
        self.assertNotIn("ENTRYPOINT", dockerfile, "a variant must not replace the agent entrypoint")

    def test_the_variant_extends_path_rather_than_replacing_it(self):
        dockerfile = (JVM / "Dockerfile").read_text()
        self.assertIn('ENV PATH="${PATH}:/opt/aee/toolchain-bin"', dockerfile)


if __name__ == "__main__":
    unittest.main()
