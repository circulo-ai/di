export enum ServiceLifetime {
  Singleton = "singleton",
  GlobalSingleton = "globalSingleton",
  Scoped = "scoped",
  Transient = "transient",
  /** One instance per resolution graph (Tsyringe-compatible). */
  ResolutionScoped = "resolutionScoped",
  /** One instance per ServiceProvider (Tsyringe-compatible). */
  ContainerScoped = "containerScoped",
}
