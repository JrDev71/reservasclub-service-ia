import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "create_reservation",
          description:
            "Cria uma nova reserva validando disponibilidade e regras da casa.",
          parameters: {
            type: "object",
            properties: {
              customerName: { type: "string", description: "Nome completo" },
              customerPhone: { type: "string", description: "Telefone" },
              customerEmail: { type: "string", description: "E-mail" },
              date: { type: "string", description: "Data (YYYY-MM-DD)" },
              spaceName: {
                type: "string",
                description: "Setor (ex: Camarote 1)",
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
      // 🚀 AQUI ESTÁ A MUDANÇA: Rota /service-ia/
      console.log(
        `[GeminiService] Consultando ROTA VIP: ${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`,
      );

      const responseMain = await axios
        .get(`${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`, {
          headers: { "x-internal-key": this.MAIN_API_TOKEN },
        })
        .catch((err) => {
          throw new Error(
            `Falha na Main API (${err.response?.status}): ${err.message}`,
          );
        });

      const nightclub = responseMain.data;
      if (!nightclub || !nightclub.aiAgent?.isActive) return null;

      const model = this.genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        tools: this.tools as any,
      });
      const chat = model.startChat({
        history: [
          {
            role: "user",
            parts: [{ text: this.buildSystemContext(nightclub) }],
          },
          {
            role: "model",
            parts: [{ text: "Assistente ReservasClub ativo." }],
          },
        ],
      });

      const result = await chat.sendMessage(message);
      const chatResponse = result.response;
      const call = chatResponse.functionCalls()?.[0];

      if (call && call.name === "create_reservation") {
        const args: any = call.args;
        const reservationResult = await this.validateAndCreate(
          nightclubId,
          nightclub,
          args,
        );
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

      return chatResponse.text();
    } catch (error: any) {
      console.error("❌ [GeminiService Error]:", error.message);
      return null;
    }
  }

  // ... (mantenha as funções validateAndCreate e buildSystemContext iguais ao passo anterior)
  private async validateAndCreate(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const requestedDate = startOfDay(new Date(args.date));
      const today = startOfDay(new Date());
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });
      if (!space) return `Erro: O setor '${args.spaceName}' não existe.`;
      const customer = await prisma.customer.upsert({
        where: {
          email:
            args.customerEmail || `user-${args.customerPhone}@reservas.com`,
        },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email:
            args.customerEmail || `user-${args.customerPhone}@reservas.com`,
        },
      });
      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: args.customerName,
          customerPhone: args.customerPhone,
          customerEmail: customer.email,
          date: requestedDate,
          amount: space.price,
          status: "PENDING",
        },
      });
      return `Sucesso! Reserva #${reservation.id.substring(0, 5)} criada.`;
    } catch (e: any) {
      return `Erro: ${e.message}`;
    }
  }

  private buildSystemContext(nightclub: any) {
    const spaces = (nightclub.spaces || [])
      .map((s: any) => `- ${s.name}: R$ ${s.price}`)
      .join("\n");
    return `VOCÊ É A YASMIN DA ${nightclub.name.toUpperCase()}.\nSETORES:\n${spaces}\nPROMPT: ${nightclub.aiAgent?.systemPrompt}`;
  }
}
