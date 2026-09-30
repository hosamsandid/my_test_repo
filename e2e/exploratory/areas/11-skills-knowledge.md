# 11 — Skills, role templates, knowledge

**Scope:** `/skills` (global/team/agent tiers, promote, publish, import, merge,
create, edit, activate/deactivate, slash commands), `/role-templates`,
`/knowledge` (team knowledge base, suggestions/promotions).

## Persona matrix

| Action | Member | Team Admin | Outsider | System Admin |
|---|---|---|---|---|
| Activate skill on own team | ? (document) | yes | no | yes |
| Write global pool | no | yes (#2178 rule) | no | yes |
| Promote team → global | no | yes | no | yes |

## Probes

- Create/edit a skill: empty name, name collision across tiers, very large
  SKILL.md, invalid front matter, `commands/*.md` → appear in the composer palette.
- Activate/deactivate on a team: per-member badges, no respawn, rapid toggling.
- Import (zip/folder), merge conflicts, delete a skill that is activated.
- Role templates: create/edit/delete, use in the wizard.
- Knowledge: search, filters, long entries, promotion suggestions — who may
  confirm/dismiss?

## Risk spots

- `skill-grants.js`, `skill-source.js`, `skill-commands.js`, `skill-transfer.js`
  (`requiredPoolWritePermission`), `planSkillSync`.

## Cleanup

Delete `uitest-` skills/role templates; deactivate skills activated on the
`uitest-` team; never touch global skills the tester did not create.
