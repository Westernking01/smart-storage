import "server-only";
import { z } from "zod";
import { ordinaryIdentity } from "./identity";
import { backendConfig } from "./config";
import { serverSupabase } from "../supabase/server";

export const LOCAL_AUTH_ISSUER =
  "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1";

/** Invoke only from an explicitly approved server-side operator context. */
export async function generateLocalProvisioningManifest(allocation: {
  quotaBytes: string;
  maxSlots: number;
}) {
  const config = backendConfig(process.env);
  if (
    !config ||
    config.environment !== "development" ||
    `${config.url}/auth/v1` !== LOCAL_AUTH_ISSUER
  )
    throw Error("PROVISIONING_ISSUER_DENIED");
  return provisioningManifest(config.url, await serverSupabase(), allocation);
}

/** Operator-only building block: no route, token logging, SQL or database client.
 * Supply an existing server-side client pinned to the approved provider URL.
 * Invocation with a live client requires separate bounded verification approval.
 */
export async function provisioningManifest(
  providerUrl: string,
  client: {
    auth: {
      getUser(): Promise<{ data: { user: unknown }; error: unknown }>;
    };
  },
  allocation: { quotaBytes: string; maxSlots: number },
) {
  if (`${providerUrl}/auth/v1` !== LOCAL_AUTH_ISSUER)
    throw Error("PROVISIONING_ISSUER_DENIED");
  const quotaBytes = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .parse(allocation.quotaBytes);
  if (BigInt(quotaBytes) > BigInt("9223372036854775807"))
    throw Error("INVALID_PROVISIONING_QUOTA");
  const maxSlots = z.number().int().min(1).max(2).parse(allocation.maxSlots);
  const { data, error } = await client.auth.getUser();
  const subject = error ? null : ordinaryIdentity(data.user);
  if (!subject) throw Error("PROVISIONING_IDENTITY_DENIED");
  return {
    issuer: LOCAL_AUTH_ISSUER,
    subject: subject.toLowerCase(),
    quotaBytes,
    maxSlots,
  };
}
