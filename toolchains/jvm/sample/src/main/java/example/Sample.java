package example;

/** Trivial subject for the toolchain demonstration (#1941). */
public final class Sample {
  private Sample() {}

  public static int add(int a, int b) {
    return a + b;
  }

  /** The running JDK's feature version — what the demonstration asserts against the pin. */
  public static int javaFeatureVersion() {
    return Runtime.version().feature();
  }

  public static void main(String[] args) {
    System.out.println("java.feature=" + javaFeatureVersion());
  }
}
