import { cloudPageAccess } from "./cloud-page-access";
import { developmentCloudConfig } from "@/lib/backend/development-cloud-config";
import { VolumeFiles } from "./volume-files";
export async function CloudFileActions() {
  const access = await cloudPageAccess();
  if (access.state !== "authenticated") return null;
  const config = developmentCloudConfig(process.env);
  if (!config) return null;
  return (
    <VolumeFiles
      key={access.account.id}
      ownerId={access.account.id}
      uploadsOnly
      cloudScope={`${config.project}-${config.bucket}`}
    />
  );
}
