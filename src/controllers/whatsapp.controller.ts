import { Request, Response } from "express";
import { enviarMensagemWhatsApp } from "../services/evolution.service";
import { prisma } from "../lib/prisma";

export const sendSimpleMessage = async (req: Request, res: Response) => {
  try {
    const { nightclubId, number, text } = req.body;
    const internalKey = req.headers["x-internal-key"];

    // 🛡️ Validação de Segurança (Chave de Serviço)
    if (!internalKey || internalKey !== process.env.MAIN_API_TOKEN) {
      return res.status(401).json({ error: "Não autorizado. Chave inválida." });
    }

    if (!nightclubId || !number || !text) {
      return res
        .status(400)
        .json({ error: "Dados insuficientes (id, number, text)." });
    }

    // 🔍 Busca a instância ativa dessa balada no banco
    const instance = await prisma.whatsappInstance.findFirst({
      where: { nightclubId, status: { in: ["CONNECTED", "OPEN"] } },
      orderBy: { createdAt: "desc" },
    });

    if (!instance) {
      return res
        .status(404)
        .json({ error: "Nenhuma instância conectada para esta balada." });
    }

    console.log(
      `[WhatsApp Controller] Enviando mensagem manual para ${number} via ${instance.instanceName}`,
    );

    // Dispara via Evolution (usando o service que já temos pronto)
    await enviarMensagemWhatsApp(instance.instanceName, number, text);

    return res
      .status(200)
      .json({ success: true, message: "Mensagem enviada com sucesso." });
  } catch (error: any) {
    console.error("❌ [sendSimpleMessage Error]:", error.message);
    return res
      .status(500)
      .json({ error: "Falha ao enviar mensagem via WhatsApp." });
  }
};
