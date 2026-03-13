import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import axios from "axios";
import {
  criarInstancia,
  configurarWebhook,
  conectarInstancia,
  abortarConexaoInstancia,
  conectarInstanciaComCodigo,
} from "../services/evolution.service";

// ============================================================================
// ☢️ FUNÇÃO AUXILIAR: A BOMBA ATÔMICA (ANQUILA A SESSÃO ZUMBI)
// ============================================================================
const forcarDesconexao = async (instanceName: string) => {
  try {
    const EVOLUTION_API_URL =
      process.env.EVOLUTION_API_URL || "http://localhost:8080";
    const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

    console.log(
      `\n[Instance] ☢️ BOMBA ATÔMICA: Deletando a instância na Evolution: ${instanceName}`,
    );

    // 1. Apaga a instância, o cache e a pasta interna do Baileys na Evolution
    await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${instanceName}`, {
      headers: { apikey: EVOLUTION_API_KEY },
      timeout: 8000,
    });

    console.log(
      `[Instance] 🧹 Instância vaporizada. Aguardando a poeira baixar (2s)...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log(
      `[Instance] 🏗️ Recriando a instância com a mente 100% limpa...`,
    );
    // 2. Recria a instância zerada
    await criarInstancia(instanceName);
  } catch (error: any) {
    // Se der 404, a instância já não existia. Apenas criamos uma nova.
    if (error.response?.status === 404) {
      console.log(`[Instance] 🤷‍♂️ A instância não existia. Criando uma nova...`);
      try {
        await criarInstancia(instanceName);
      } catch (createError: any) {
        console.log(
          `[Instance] ❌ Erro ao criar instância (Plano B):`,
          createError.message,
        );
      }
    } else {
      console.log(
        `[Instance] ⚠️ Detalhe na Bomba Atômica:`,
        error.response?.data || error.message,
      );
    }
  }
};

// ============================================================================
// 🕰️ FUNÇÃO AUXILIAR: A GUILHOTINA DE 45 SEGUNDOS
// ============================================================================
const iniciarCronometroCancelamento = (instanceName: string) => {
  setTimeout(async () => {
    try {
      const instancia = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      if (
        instancia &&
        (instancia.status === "QRCODE" || instancia.status === "CONNECTING")
      ) {
        console.log(
          `[Timer] ⏰ 45s passaram. Conexão não concluída para ${instanceName}.`,
        );

        await abortarConexaoInstancia(instanceName);

        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "DISCONNECTED", qrCode: null },
        });

        console.log(
          `[Timer] 🛑 Instância ${instanceName} resetada para DISCONNECTED no banco.`,
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

    return res.status(200).json({ success: true, instance: whatsappInstance });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);
    return res.status(500).json({ error: "Erro ao criar a instância." });
  }
};

// ============================================================================
// 2. RECONEXÃO / FALLBACK (VIA QR CODE TRADICIONAL)
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
      `\n[Instance] 🔄 Iniciando Fluxo de QR Code para: ${instanceName}`,
    );

    // ☢️ Limpa o terreno matando qualquer zumbi
    await forcarDesconexao(instanceName);

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    const evolutionResponse = await conectarInstancia(instanceName);

    const qrCodeBase64 =
      evolutionResponse?.base64 || evolutionResponse?.qrcode?.base64 || null;
    const initialStatus = qrCodeBase64 ? "QRCODE" : "CONNECTING";

    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: { status: initialStatus, qrCode: qrCodeBase64 },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({ success: true, instance: whatsappInstance });
  } catch (error: any) {
    console.error("[Instance Connect Error]", error.message || error);
    return res
      .status(500)
      .json({ error: "Erro ao reconectar a instância. Tente novamente." });
  }
};

// ============================================================================
// 3. 🔢 RECONEXÃO VIA CÓDIGO DE PAREAMENTO (NOVO MÉTODO)
// ============================================================================
export const connectNightclubWithCode = async (req: Request, res: Response) => {
  try {
    const { nightclubId, number } = req.body;

    if (!nightclubId || !number)
      return res
        .status(400)
        .json({ error: "ID da balada e número são obrigatórios." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `\n[Instance] 🔢 Iniciando Pairing Code para: ${instanceName} / Número: ${number}`,
    );

    // ☢️ Limpa o terreno matando qualquer zumbi antes de pedir código
    await forcarDesconexao(instanceName);

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    // Agora o Baileys não tem como dar desculpa, a instância acabou de nascer!
    const evolutionResponse = await conectarInstanciaComCodigo(
      instanceName,
      number,
    );

    console.log(
      `[DEBUG] Resposta Bruta da Evolution:`,
      JSON.stringify(evolutionResponse),
    );

    const pairingCode =
      evolutionResponse?.code ||
      evolutionResponse?.pairingCode ||
      evolutionResponse?.pairingCodeResponse?.code;

    if (!pairingCode) {
      console.error(
        `[CRÍTICO] Evolution não devolveu o código. A resposta está salva acima.`,
      );
      throw new Error(
        "Evolution não retornou o código de pareamento. Verifique se o número possui WhatsApp ativo e se o DDD está correto.",
      );
    }

    await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: { status: "CONNECTING", qrCode: null },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: "CONNECTING",
        qrCode: null,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    console.log(`[Instance] ✅ Código de Pareamento gerado: ${pairingCode}`);

    return res.status(200).json({ success: true, code: pairingCode });
  } catch (error: any) {
    console.error("[Instance Connect Code Error]", error.message || error);
    return res.status(500).json({
      error:
        error.message ||
        "Erro ao gerar código de pareamento. Verifique o console.",
    });
  }
};
