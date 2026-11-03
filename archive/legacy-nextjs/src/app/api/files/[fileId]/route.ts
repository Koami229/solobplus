import { NextResponse } from "next/server";
import { getAuthenticatedUserFromRequest } from "@/lib/core/auth";
import { handleApiError } from "@/lib/core/http";
import { AppError } from "@/lib/core/rbac";
import { readAuthorizedFile } from "@/lib/core/storage";

export async function GET(
  req: Request,
  context: { params: Promise<{ fileId: string }> }
) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      throw new AppError("Authentication required to access private files.", 401, "UNAUTHENTICATED");
    }
    const { fileId } = await context.params;
    const { record, content } = await readAuthorizedFile(user, fileId);
    return NextResponse.json({
      ok: true,
      metadata: record,
      textContent: content.toString("utf8"),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
