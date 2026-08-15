import {
  ServiceCollection,
  annotate,
  createToken,
  injectable,
  optional,
} from "@circulo-ai/di";

type Logger = { info(message: string): void };
type Database = {
  findUser(id: string): Promise<{ id: string; name: string } | undefined>;
};
type Metrics = { increment(name: string): void };

const TOKENS = {
  Database: createToken<Database>("Database"),
  Logger: createToken<Logger>("Logger"),
  Metrics: createToken<Metrics>("Metrics"),
  Users: createToken<UserService>("UserService"),
  Audit: createToken<AuditService>("AuditService"),
} as const;

// Positional dependencies work naturally with ordinary constructors. The
// database is async, so its class binding opts into async dependency resolution.
@injectable([TOKENS.Database, TOKENS.Logger, optional(TOKENS.Metrics)])
class UserService {
  constructor(
    private readonly database: Database,
    private readonly logger: Logger,
    private readonly metrics: Metrics | undefined,
  ) {}

  async getUser(id: string) {
    this.logger.info(`loading user ${id}`);
    this.metrics?.increment("users.read");
    return this.database.findUser(id);
  }
}

// Decorator syntax is optional. Named dependencies are injected as one object.
class AuditService {
  constructor(private readonly dependencies: { logger: Logger }) {}

  record(message: string): void {
    this.dependencies.logger.info(`audit: ${message}`);
  }
}
annotate(AuditService, { logger: TOKENS.Logger });

@injectable([TOKENS.Logger])
class RequestDiagnostics {
  constructor(readonly logger: Logger) {}
}

const events: string[] = [];
const services = new ServiceCollection({ allowOverwrite: false })
  .addGlobalSingleton(
    TOKENS.Database,
    async () => ({
      async findUser(id: string) {
        return { id, name: "Ada" };
      },
    }),
    { globalKey: "annotations-example-db" },
  )
  .addSingleton(TOKENS.Logger, {
    info(message: string) {
      events.push(message);
    },
  });

services
  .bind(TOKENS.Users)
  .toAnnotatedClass(UserService, { scope: "scoped", async: true });
services.bind(TOKENS.Audit).toAnnotatedClass(AuditService, { scope: "scoped" });
// Like Microsoft.Extensions.DependencyInjection, annotated classes can
// self-register with a lifetime and use the class itself as the token.
services.addScoped(RequestDiagnostics);

const provider = services.buildServiceProvider({ validateOnBuild: true });

await provider.withScope(async (scope) => {
  const users = await scope.resolveAsync(TOKENS.Users);
  const audit = scope.serviceProvider.getRequiredService(TOKENS.Audit);
  const diagnostics = scope.getRequiredService(RequestDiagnostics);
  const missing = scope.getService("unregistered");
  const user = await users.getUser("user-1");
  audit.record(`returned ${user?.name}`);

  if (user?.name !== "Ada") throw new Error("Annotation example failed.");
  if (!diagnostics.logger || missing !== undefined) {
    throw new Error(".NET-style resolver aliases failed.");
  }
});

if (events.length !== 2)
  throw new Error("Expected both example services to run.");
console.log("annotation example passed");
