import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    "A variável de ambiente GEMINI_API_KEY não está configurada no .env",
  );
}

const genAI = new GoogleGenerativeAI(apiKey);

export const processarMensagemIA = async (
  systemPrompt: string,
  mensagemUsuario: string,
) => {
  // Inicializa o modelo injetando as regras específicas da balada (tenant)
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: systemPrompt,
    tools: [
      {
        functionDeclarations: [
          {
            name: "gerar_link_pagamento",
            description:
              "Gera um link de pagamento único via Mercado Pago para confirmar a reserva no sistema ReservasClub.",
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                nome_cliente: {
                  type: SchemaType.STRING,
                  description:
                    "Nome completo do cliente que está fazendo a reserva.",
                },
                data_reserva: {
                  type: SchemaType.STRING,
                  description:
                    "Data para qual a reserva está sendo solicitada (formato YYYY-MM-DD).",
                },
                tipo_reserva: {
                  type: SchemaType.STRING,
                  description:
                    "O tipo da reserva solicitada. Deve ser 'MESA', 'CAMAROTE' ou 'BISTRO'.",
                },
              },
              required: ["nome_cliente", "data_reserva", "tipo_reserva"],
            },
          },
        ],
      },
    ],
  });

  // Inicia a conversa e envia a mensagem do cliente
  const chat = model.startChat();
  const result = await chat.sendMessage(mensagemUsuario);

  return result.response;
};
