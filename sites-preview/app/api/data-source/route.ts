export async function GET() {
  return Response.json({
    enabled: false,
    configured: false,
    installed: false,
    ready: false,
    allowedMethods: [],
    autoVerify: false,
    preview: true,
  });
}
