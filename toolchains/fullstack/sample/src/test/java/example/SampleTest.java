package example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Runs under `mvn test` inside an agent container to prove the fullstack
 * toolchain's Java half works (#1941 AC5). The version assertion is what makes
 * AC6/AC7 checkable: the test reads the JDK it is running on, and the
 * demonstration script compares that to the version this project pinned.
 */
class SampleTest {

  @Test
  void addsNumbers() {
    assertEquals(7, Sample.add(3, 4));
  }

  @Test
  void reportsTheRunningJavaVersion() {
    int feature = Sample.javaFeatureVersion();
    System.out.println("AEE_TOOLCHAIN_JAVA_FEATURE=" + feature);
    assertTrue(feature >= 17, "expected a modern JDK, got " + feature);
  }
}
