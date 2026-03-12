import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  criarInstancia,
  configurarWebhook,
  conectarInstancia,
  abortarConexaoInstancia,
} from "../services/evolution.service";

// ============================================================================
// 🕰️ FUNÇÃO AUXILIAR: A GUILHOTINA DE 45 SEGUNDOS
// ============================================================================
const iniciarCronometroCancelamento = (instanceName: string) => {
  setTimeout(async () => {
    try {
      const instancia = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      // Se passou 45s e AINDA está travado no QR Code ou Connecting
      if (
        instancia &&
        (instancia.status === "QRCODE" || instancia.status === "CONNECTING")
      ) {
        console.log(
          `[Timer] ⏰ 45 segundos passaram. QR Code não foi lido para ${instanceName}. Abortando...`,
        );

        await abortarConexaoInstancia(instanceName);

        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "DISCONNECTED", qrCode: null },
        });

        console.log(
          `[Timer] 🛑 Instância ${instanceName} resetada para DISCONNECTED.`,
        );
      }
    } catch (error: any) {
      console.error(
        `[Timer Error] Falha ao abortar conexão de ${instanceName}:`,
        error.message,
      );
    }
  }, 45000);
};

// ============================================================================
// 1. CRIAÇÃO DE NOVA INSTÂNCIA (A primeira vez)
// ============================================================================
export const createNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.body;

    if (!nightclubId) return res.status(400).json({ error: "ID obrigatório." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `[Instance] Iniciando criação na Evolution API: ${instanceName}`,
    );

    const evolutionResponse = await criarInstancia(instanceName);
    const qrCodeBase64 = evolutionResponse?.qrcode?.base64 || "";

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: {
        status: "QRCODE",
        qrCode: qrCodeBase64,
        nightclubId: nightclub.id,
      },
      create: {
        instanceName,
        status: "QRCODE",
        qrCode: qrCodeBase64,
        nightclubId: nightclub.id,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({
      success: true,
      instance: whatsappInstance,
    });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);

    const errorData = error.response?.data || {};
    const errorStr = JSON.stringify(errorData).toLowerCase();

    if (
      error.response?.status === 409 ||
      (error.response?.status === 403 && errorStr.includes("already in use")) ||
      error.message?.includes("already exists")
    ) {
      console.log(
        `[Instance] Instância já existe. Avisando backend principal para fazer fallback...`,
      );
      return res.status(409).json({ error: "Instância já existe." });
    }

    return res.status(500).json({ error: "Erro ao criar a instância." });
  }
};

// ============================================================================
// 2. RECONEXÃO / FALLBACK (Com Auto-Sync de Banco de Dados)
// ============================================================================
export const connectNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.params;

    if (!nightclubId)
      return res.status(400).json({ error: "ID obrigatório na URL." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `[Instance] 🔄 Solicitando reconexão na Evolution: ${instanceName}`,
    );

    // 👻 EXORCISMO DO WEBHOOK: Atualizamos a URL da Evolution antes de pedir o QR Code
    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    // Agora sim pedimos a conexão
    const evolutionResponse = await conectarInstancia(instanceName);

    // Às vezes a Evolution não devolve na hora. Se vier vazio, o Webhook vai salvar depois.
    const qrCodeBase64 =
      evolutionResponse?.base64 || evolutionResponse?.qrcode?.base64 || null;
    const initialStatus = qrCodeBase64 ? "QRCODE" : "CONNECTING";

    // 🛡️ MUDANÇA CRÍTICA: Trocado update por UPSERT.
    // Se a Evolution tem a instância, mas nosso banco local não tem, nós criamos agora!
    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: {
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({
      success: true,
      instance: whatsappInstance,
    });
  } catch (error: any) {
    console.error("[Instance Connect Error]", error.message || error);
    return res.status(500).json({ error: "Erro ao reconectar a instância." });
  }
};
