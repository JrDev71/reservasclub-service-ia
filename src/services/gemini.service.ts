import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";

  constructor() {
    // Configura a chave do Gemini do .env do microserviço
    const apiKey = process.env.GEMINI_API_KEY || "";
    this.genAI = new GoogleGenerativeAI(apiKey);

    // Usamos o modelo Flash para velocidade e baixo custo
    this.model = this.genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });
  }

  /**
   * 🧠 O CÉREBRO: Constrói o prompt e gera a resposta
   */
  async generateResponse(
    nightclubId: string,
    customerPhone: string,
    message: string,
  ) {
    try {
      // 1. Busca os dados atualizados da balada na API Principal
      // (Preços, Mesas, Regras e o Treinamento do Dono)
      const { data: nightclub } = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/${nightclubId}`,
      );

      if (!nightclub.aiAgent?.isActive) {
        console.log(
          `[GeminiService] IA desativada para a balada: ${nightclub.name}`,
        );
        return null;
      }

      // 2. Monta a "Verdade Absoluta" do Sistema (Contexto)
      const systemContext = this.buildSystemContext(nightclub);

      // 3. Inicia o Chat com as instruções
      const chat = this.model.startChat({
        history: [
          {
            role: "user",
            parts: [{ text: systemContext }],
          },
          {
            role: "model",
            parts: [
              {
                text: `Entendido. Sou o assistente oficial da ${nightclub.name}. Como posso ajudar?`,
              },
            ],
          },
        ],
      });

      // 4. Envia a mensagem do cliente
      const result = await chat.sendMessage(message);
      const response = result.response.text();

      // 5. Verificação de Segurança: A IA tentou inventar algo?
      return this.sanitizeResponse(response);
    } catch (error: any) {
      console.error("[GeminiService] Erro Crítico:", error.message);
      // Se der erro, não respondemos nada para evitar o "tente novamente" público
      // O controlador deve tratar o aviso ao dono
      throw error;
    }
  }

  /**
   * 🛠️ CONSTRUTOR DE CONTEXTO: Onde a IA aprende sobre a casa
   */
  private buildSystemContext(nightclub: any) {
    const spacesInfo = nightclub.spaces
      .map(
        (s: any) =>
          `- ${s.name}: Capacidade ${s.capacity} pessoas, Valor R$ ${s.price}`,
      )
      .join("\n");

    return `
      VOCÊ É O ASSISTENTE VIRTUAL DA BALADA: ${nightclub.name.toUpperCase()}.
      
      --- REGRAS DE OURO (NÃO NEGOCIÁVEIS) ---
      1. Use apenas as informações abaixo para responder.
      2. Se o cliente quiser reservar, peça NOME e TELEFONE.
      3. Se você não souber uma resposta, diga: "Vou encaminhar sua dúvida para um atendente humano agora mesmo."
      4. JAMAIS invente preços ou horários que não estejam aqui.
      5. Seja educado, direto e mantenha o tom de voz definido pelo dono.

      --- INFORMAÇÕES DA CASA ---
      WhatsApp Oficial: ${nightclub.whatsapp}
      Setores Disponíveis:
      ${spacesInfo}

      --- TREINAMENTO PERSONALIZADO DO DONO ---
      ${nightclub.aiAgent.systemPrompt || "Seja um atendente profissional e eficiente."}

      --- AGORA RESPONDA O CLIENTE ---
    `;
  }

  /**
   * 🛡️ SANITIZAÇÃO: Filtra alucinações comuns
   */
  private sanitizeResponse(text: string) {
    if (
      text.includes("não tenho certeza") ||
      text.includes("desculpe, não sei")
    ) {
      return text + "\n\n(Aguarde, um atendente humano foi notificado).";
    }
    return text;
  }
}
