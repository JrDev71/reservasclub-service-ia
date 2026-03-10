import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma"; // Usando o prisma do microserviço

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY || "";
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  /**
   * 🛠️ DEFINIÇÃO DA FERRAMENTA (TOOL)
   * Avisa ao Gemini que ele pode criar reservas
   */
  private tools = [
    {
      functionDeclarations: [
        {
          name: "create_reservation",
          description:
            "Cria uma nova reserva no banco de dados para um cliente.",
          parameters: {
            type: "object",
            properties: {
              customerName: {
                type: "string",
                description: "Nome completo do cliente",
              },
              customerPhone: {
                type: "string",
                description: "Telefone de contato",
              },
              customerEmail: {
                type: "string",
                description: "E-mail do cliente (opcional)",
              },
              date: {
                type: "string",
                description: "Data da reserva no formato YYYY-MM-DD",
              },
              spaceName: {
                type: "string",
                description: "Nome do setor/mesa/camarote desejado",
              },
            },
            required: ["customerName", "customerPhone", "date", "spaceName"],
          },
        },
      ],
    },
  ];

  async generateResponse(
    nightclubId: string,
    customerPhone: string,
    message: string,
  ) {
    try {
      const { data: nightclub } = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/${nightclubId}`,
      );

      if (!nightclub.aiAgent?.isActive) return null;

      const model = this.genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        tools: this.tools as any, // 👈 Injeta as ferramentas aqui
      });

      const chat = model.startChat({
        history: [
          {
            role: "user",
            parts: [{ text: this.buildSystemContext(nightclub) }],
          },
          {
            role: "model",
            parts: [
              {
                text: "Entendido. Sou o assistente oficial. Posso realizar reservas agora.",
              },
            ],
          },
        ],
      });

      const result = await chat.sendMessage(message);
      const response = result.response;
      const call = response.functionCalls()?.[0];

      // 1. SE A IA DECIDIU CHAMAR A FUNÇÃO DE RESERVA
      if (call && call.name === "create_reservation") {
        const args: any = call.args;

        // Executamos a reserva no banco real
        const reservationResult = await this.executeCreateReservation(
          nightclubId,
          args,
        );

        // Devolvemos o resultado para a IA para ela confirmar ao cliente
        const finalResponse = await chat.sendMessage([
          {
            functionResponse: {
              name: "create_reservation",
              response: { content: reservationResult },
            },
          },
        ]);

        return finalResponse.response.text();
      }

      // 2. SE FOR APENAS CONVERSA NORMAL
      return response.text();
    } catch (error: any) {
      console.error("[GeminiService] Erro:", error.message);
      return "Desculpe, tive um problema técnico. Um atendente humano já foi avisado.";
    }
  }

  /**
   * 💾 EXECUÇÃO NO BANCO DE DADOS
   */
  private async executeCreateReservation(nightclubId: string, args: any) {
    try {
      // 1. Tenta achar o Space pelo nome dentro daquela balada
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
        },
      });

      if (!space) {
        return `Erro: Não encontrei nenhum setor com o nome '${args.spaceName}'. Pergunte ao cliente qual setor ele deseja entre os disponíveis.`;
      }

      // 2. Cria a reserva
      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerName: args.customerName,
          customerPhone: args.customerPhone,
          customerEmail: args.customerEmail || null,
          date: new Date(args.date),
          status: "PENDING",
        },
      });

      return `Sucesso! Reserva criada com ID ${reservation.id}. Informe ao cliente que a reserva para o setor ${space.name} no dia ${args.date} está pré-confirmada e aguardando pagamento.`;
    } catch (error: any) {
      console.error("[DB Error]", error.message);
      return "Erro interno ao salvar no banco. Peça para o cliente aguardar um momento.";
    }
  }

  private buildSystemContext(nightclub: any) {
    const spacesInfo = nightclub.spaces
      .map((s: any) => `- ${s.name}: R$ ${s.price} (Capacidade: ${s.capacity})`)
      .join("\n");

    return `
      VOCÊ É O ASSISTENTE DA BALADA ${nightclub.name.toUpperCase()}.
      DATA ATUAL: ${new Date().toISOString().split("T")[0]}.

      INFORMAÇÕES DE SETORES:
      ${spacesInfo}

      REGRAS:
      - Para reservar, você PRECISA de: Nome, Telefone, Data e Setor.
      - Quando tiver esses 4 dados, use a ferramenta 'create_reservation'.
      - Se o cliente perguntar algo que não sabe, chame um humano.
      
      TREINAMENTO:
      ${nightclub.aiAgent.systemPrompt || "Seja eficiente."}
    `;
  }
}
