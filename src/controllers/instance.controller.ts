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
// 🪓 FUNÇÃO AUXILIAR: A VERDADEIRA OBLITERAÇÃO (DELETE DIRETO NA RAIZ)
// ============================================================================
const forcarDesconexao = async (instanceName: string) => {
  const EVOLUTION_API_URL =
    process.env.EVOLUTION_API_URL || "http://localhost:8080";
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

  try {
    console.log(
      `\n[Instance] 🪓 Obliterando a instância na raiz: ${instanceName}`,
    );
    // Na v2, a única forma de garantir a limpeza é DELETAR a instância do banco da API
    await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${instanceName}`, {
      headers: { apikey: EVOLUTION_API_KEY },
      timeout: 5000,
    });
    console.log(`[Instance] ✅ Instância deletada com sucesso do servidor.`);
  } catch (error: any) {
    // Se der 404, ótimo, ela já não existia. Segue o jogo.
    console.log(
      `[Instance] ⚠️ Deleção ignorada ou já não existia. Motivo:`,
      error.response?.data?.message?.[0] || error.message,
    );
  }

  // Dá 2 segundos de respiro pro Redis limpar o cache interno
  await new Promise((resolve) => setTimeout(resolve, 2000));
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
        // Usa a nossa nova voadora para varrer o lixo
        await forcarDesconexao(instanceName);

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
// 1. CRIAÇÃO DE NOVA INSTÂNCIA (QR Code Padrão)
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
    console.log(`\n[Instance] Iniciando fluxo de Criação: ${instanceName}`);

    let qrCodeBase64 = "";

    try {
      const evolutionResponse = await criarInstancia(instanceName);
      qrCodeBase64 = evolutionResponse?.qrcode?.base64 || "";
      console.log(`[Instance] ✅ Criada do zero com sucesso.`);
    } catch (createError: any) {
      const errorMessage = createError.response?.data?.message?.[0] || "";
      const isAlreadyInUse =
        errorMessage.includes("already in use") ||
        createError.response?.status === 403;

      if (isAlreadyInUse) {
        console.log(
          `[Instance] ⚠️ Instância já existe. Derrubando sessão zumbi...`,
        );
        await forcarDesconexao(instanceName);

        // O SEGREDO AQUI: Como nós deletamos a instância, temos que CRIAR ela de novo, e não "conectar"
        console.log(`[Instance] 🔄 Recriando instância limpa...`);
        const retryResponse = await criarInstancia(instanceName);
        qrCodeBase64 = retryResponse?.qrcode?.base64 || "";
      } else {
        throw createError;
      }
    }

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
    return res
      .status(500)
      .json({ error: "Erro ao criar ou resetar a instância." });
  }
};

// ============================================================================
// 2. RECONEXÃO / FALLBACK (VIA QR CODE TRADICIONAL)
// ============================================================================
export const connectNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.params;
    if (!nightclubId) return res.status(400).json({ error: "ID obrigatório." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });
    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `\n[Instance] 🔄 Iniciando Fluxo de QR Code para: ${instanceName}`,
    );

    // Mata qualquer rastro anterior
    await forcarDesconexao(instanceName);

    // Cria zerado de novo
    const evolutionResponse = await criarInstancia(instanceName);

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

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
// 3. 🔢 RECONEXÃO VIA CÓDIGO DE PAREAMENTO
// ============================================================================
export const connectNightclubWithCode = async (req: Request, res: Response) => {
  try {
    const { nightclubId, number } = req.body;
    if (!nightclubId || !number)
      return res.status(400).json({ error: "ID e número são obrigatórios." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });
    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `\n[Instance] 🔢 Iniciando Pairing Code para: ${instanceName} / Número: ${number}`,
    );

    // 1. Oblitera qualquer sessão antiga para garantir injeção do número na raiz
    await forcarDesconexao(instanceName);

    // 2. CRIA DO ZERO já enviando o número (Evolution v2 exige assim para código numérico)
    const evolutionResponse = await criarInstancia(instanceName, number);

    // 3. Configura o Webhook na instância nova
    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    // 4. Captura o código numérico no retorno da criação
    let pairingCode =
      evolutionResponse?.pairingCode ||
      evolutionResponse?.code ||
      evolutionResponse?.qrcode?.code;

    // 5. Fallback de garantia: Se a criação não devolver o código na hora, força a busca manual
    if (!pairingCode) {
      console.log(
        "[Instance] Código não retornou no payload principal, forçando busca...",
      );
      const codeRes = await conectarInstanciaComCodigo(instanceName, number);
      pairingCode = codeRes?.pairingCode || codeRes?.code;
    }

    if (!pairingCode) {
      console.error(`[CRÍTICO] Evolution não gerou o código de 8 dígitos!`);
      throw new Error(
        "Evolution não retornou o código. Verifique se o número possui WhatsApp ativo e se o DDD está correto.",
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

    console.log(
      `[Instance] ✅ Código de Pareamento finalizado: ${pairingCode}`,
    );

    return res.status(200).json({ success: true, code: pairingCode });
  } catch (error: any) {
    console.error("[Instance Connect Code Error]", error.message || error);
    return res.status(500).json({
      error: error.message || "Erro ao gerar código de pareamento.",
    });
  }
};
