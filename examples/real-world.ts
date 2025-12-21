// Real-world @circulo-ai/di examples.
// Run snippets by copying into your app and adjusting imports/resources.

import {
  ServiceCollection,
  createModule,
  getGlobalProvider,
  withRequestScope,
} from "@circulo-ai/di";

// ---------------------------------------------------------------------------
// 1) Next.js App Route: global pool + scoped logger
// ---------------------------------------------------------------------------
const TYPES = { Db: "Db", Logger: "Logger" } as const;

// Reuse the provider across hot reloads and edge/runtime invocations.
export const provider = getGlobalProvider(() => {
  const services = new ServiceCollection();
  services
    .bind(TYPES.Db)
    .toHigherOrderFunction(() => createPool(), [], { scope: "global" });
  services
    .bind(TYPES.Logger)
    .toFactory(() => createRequestLogger(), { scope: "scoped" });
  return services.build();
});

// Wrap a handler so every request gets a fresh scope that disposes automatically.
export const GET = withRequestScope(provider, async (_req: Request, ctx) => {
  const db = await ctx.container.resolveAsync(TYPES.Db);
  const logger = ctx.container.resolve(TYPES.Logger);
  const users = await db.query("select * from users");
  logger.info("users fetched", { count: users.length });
  return new Response(JSON.stringify({ users }), {
    headers: { "content-type": "application/json" },
  });
});

// ---------------------------------------------------------------------------
// 2) Feature module using the binder DSL
// ---------------------------------------------------------------------------
export const userModule = createModule()
  .bind("UserRepo")
  .toClass(UserRepository, { db: TYPES.Db }) // object deps map to ctor args
  .bind("GetUser")
  .toHigherOrderFunction(
    (repo: UserRepository) => (id: string) => repo.findById(id),
    ["UserRepo"],
  );

// Compose modules + core services
export const appServices = new ServiceCollection()
  .addGlobalSingleton(TYPES.Db, () => createPool(), { disposePriority: 10 })
  .addModule(userModule);

export const appProvider = appServices.build();

// ---------------------------------------------------------------------------
// 3) Background worker with scoped disposals
// ---------------------------------------------------------------------------
export const workerServices = new ServiceCollection()
  .addGlobalSingleton("Queue", () => connectQueue(), { disposePriority: 5 })
  .bind("JobLogger")
  .toFactory(() => createJobLogger(), { scope: "scoped" });

export const workerProvider = workerServices.build();

export async function handleJob(job: { id: string }) {
  return workerProvider.withScope(async (scope) => {
    const queue = scope.resolve("Queue");
    const log = scope.resolve("JobLogger");
    log.info("processing", job.id);
    await queue.ack(job.id);
  });
}

// ---------------------------------------------------------------------------
// Helpers used in the examples (replace with your own implementations).
// ---------------------------------------------------------------------------
function createPool(): { query: (sql: string) => Promise<any[]> } {
  return {
    async query() {
      return [];
    },
  };
}

class UserRepository {
  constructor(
    private readonly deps: { db: { query: (sql: string) => Promise<any[]> } },
  ) {}
  async findById(id: string) {
    const rows = await this.deps.db.query(
      `select * from users where id='${id}'`,
    );
    return rows[0];
  }
}

function createRequestLogger() {
  return {
    info: (msg: string, meta?: unknown) => console.info(msg, meta),
  };
}

function connectQueue() {
  return {
    ack: async (id: string) => {
      console.log("acked", id);
    },
  };
}

function createJobLogger() {
  return {
    info: (msg: string, meta?: unknown) => console.info(msg, meta),
  };
}
