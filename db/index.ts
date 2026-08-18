import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { getStorage } from "./books";

export function getDb() {
  return drizzle(getStorage().db, { schema });
}
