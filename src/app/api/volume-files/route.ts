import { volumeGet, volumePost } from "@/lib/gateway/volume-http.server";
export const runtime = "nodejs";
export const GET = volumeGet;
export const POST = volumePost;
