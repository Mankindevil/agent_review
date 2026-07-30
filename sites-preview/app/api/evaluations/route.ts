export async function GET() {
  return Response.json([]);
}

export async function POST() {
  return Response.json(
    { error: "线上预览仅展示前端，真实评测服务尚未部署。" },
    { status: 503 },
  );
}
