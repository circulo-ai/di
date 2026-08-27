import type { ServiceCollection } from "../core/service-collection.js";

type RegisterFn = (services: ServiceCollection) => void;

const getEnv = () =>
  typeof process !== "undefined" && process.env
    ? (process.env.NODE_ENV ?? "development")
    : "development";

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
  if (typeof process !== "undefined" && process.env?.[envVar]) {
    register(services);
  }
  return services;
}
