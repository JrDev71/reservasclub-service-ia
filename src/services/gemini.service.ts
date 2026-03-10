import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY || "";
    this.genAI = new GoogleGenerativeAI(apiKey);
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
              customerName: {
                type: "string",
                description: "Nome completo do cliente",
              },
              customerPhone: {
                type: "string",
                description: "Telefone (apenas números)",
              },
              customerEmail: {
                type: "string",
                description: "E-mail (opcional)",
              },
              date: {
                type: "string",
                description: "Data da reserva (YYYY-MM-DD)",
              },
              spaceName: {
                type: "string",
                description: "Nome do setor (ex: Camarote 1)",
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
      // 1. Busca dados e SETTINGS da balada
      const { data: nightclub } = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/${nightclubId}`,
      );
      if (!nightclub.aiAgent?.isActive) return null;

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
            parts: [
              {
                text: "Assistente ReservasClub ativo. Validação de banco sincronizada.",
              },
            ],
          },
        ],
      });

      const result = await chat.sendMessage(message);
      const response = result.response;
      const call = response.functionCalls()?.[0];

      if (call && call.name === "create_reservation") {
        const args: any = call.args;

        // 🚀 A MÁGICA: Executa validação pesada antes de salvar
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

      return response.text();
    } catch (error: any) {
      console.error("[GeminiService Error]", error.message);
      return "Estou processando sua solicitação, um momento...";
    }
  }

  private async validateAndCreate(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const requestedDate = startOfDay(new Date(args.date));
      const today = startOfDay(new Date());

      // 1. Validação de Antecedência (Lead Time)
      // Pegamos do settings JSON que você definiu no admin
      const settings = nightclub.settings || {};
      const maxDays = settings.reservationLeadTimeDays || 30; // Default 30 dias se não definido
      const limitDate = addDays(today, maxDays);

      if (isBefore(requestedDate, today))
        return "Erro: Não aceitamos reservas para datas passadas.";
      if (isAfter(requestedDate, limitDate))
        return `Erro: Só aceitamos reservas com até ${maxDays} dias de antecedência.`;

      // 2. Busca o Setor (Space)
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });

      if (!space)
        return `Erro: O setor '${args.spaceName}' não existe ou está em manutenção.`;

      // 3. CHECK DE DISPONIBILIDADE (O Pulo do Gato 🐱)
      const existing = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date: requestedDate,
          status: { in: ["CONFIRMED", "PENDING"] }, // Se tem alguém pagando ou confirmado, trava.
        },
      });

      if (existing)
        return `Erro: O ${space.name} já está reservado para esta data (${args.date}). Tente outro setor ou data.`;

      // 4. CRM: Busca ou Cria o Cliente (Para não duplicar)
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

      // 5. Cria a Reserva Final
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

      return `Sucesso! Reserva #${reservation.id.substring(0, 5)} criada para ${args.customerName}. Setor: ${space.name} | Data: ${args.date}. O link de pagamento será enviado em breve.`;
    } catch (error: any) {
      return `Erro sistêmico: ${error.message}`;
    }
  }

  private buildSystemContext(nightclub: any) {
    const spaces = nightclub.spaces
      .map((s: any) => `- ${s.name}: R$ ${s.price}`)
      .join("\n");
    return `
      VOCÊ É O ASSISTENTE DA ${nightclub.name.toUpperCase()}.
      HOJE É: ${format(new Date(), "yyyy-MM-dd")}.
      
      SETORES DISPONÍVEIS:
      ${spaces}

      REGRAS:
      1. Use a ferramenta 'create_reservation' apenas quando tiver Nome, Telefone, Data e Setor.
      2. Nunca prometa disponibilidade sem chamar a ferramenta.
      3. Seja educado e use a personalidade definida: ${nightclub.aiAgent.systemPrompt}
    `;
  }
}
