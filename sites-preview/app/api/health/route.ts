export async function GET() {
  return Response.json({
    blackBoxEvaluation: { enabled: true },
    evaluationSeed: 20260720,
    modelTemperature: 0,
    preview: true,
  });
}
