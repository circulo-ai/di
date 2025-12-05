import type { ServiceCollection } from "./service-collection";

type RegisterFn = (services: ServiceCollection) => void;

const getEnv = () => process.env.NODE_ENV ?? "development";

export function ifProd(
  services: ServiceCollection,
  register: RegisterFn,
): ServiceCollection {
  if (getEnv() === "production") register(services);
  return services;
}

export function ifDev(
  services: ServiceCollection,
  register: RegisterFn,
): ServiceCollection {
  if (getEnv() === "development") register(services);
  return services;
}

export function ifTruthy(
  services: ServiceCollection,
  envVar: string,
  register: RegisterFn,
): ServiceCollection {
  if (process.env[envVar]) register(services);
  return services;
}
