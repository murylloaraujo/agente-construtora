const express = require("express");
const axios = require("axios");
const multer = require("multer");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));
const upload = multer({ dest: "uploads/" });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const PORT = process.env.PORT || 3000;

// Banco de dados em memória (substituir por banco real futuramente)
let notas = [];

async function enviarMensagem(numero, mensagem) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: numero, text: mensagem },
      { headers: { apikey: EVOLUTION_API_KEY } }
    );
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.message);
  }
}

async function extrairDadosNF(texto, imagemBase64 = null) {
  const content = [];

  if (imagemBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imagemBase64 },
    });
  }

  content.push({
    type: "text",
    text: `Você é um assistente especializado em notas fiscais brasileiras de construtoras.
Extraia os dados da nota fiscal abaixo e retorne APENAS um JSON válido, sem explicações.

${texto ? "Texto da NF: " + texto : ""}

Formato exato do JSON:
{
  "fornecedor": "nome do fornecedor",
  "dataFaturamento": "DD/MM/AAAA",
  "vencimento": "DD/MM/AAAA",
  "valor": 0.00,
  "obra": "nome da obra ou centro de custo",
  "formaPagamento": "PIX ou Boleto ou Depósito",
  "numeroNF": "número da NF"
}

Se algum campo não encontrar, use null.`,
  });

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  const texto_resposta = response.data.content[0].text;
  const json_match = texto_resposta.match(/\{[\s\S]*\}/);
  if (json_match) return JSON.parse(json_match[0]);
  return null;
}

function gerarRelatorioVencimentos() {
  const hoje = new Date();
  const pendentes = notas.filter((n) => !n.pago);

  if (pendentes.length === 0) return "✅ Nenhum pagamento pendente.";

  const vencidos = pendentes.filter((n) => {
    const [d, m, a] = n.vencimento.split("/");
    return new Date(`${a}-${m}-${d}`) < hoje;
  });

  const venceHoje = pendentes.filter((n) => {
    const [d, m, a] = n.vencimento.split("/");
    const data = new Date(`${a}-${m}-${d}`);
    return data.toDateString() === hoje.toDateString();
  });

  const proximos = pendentes.filter((n) => {
    const [d, m, a] = n.vencimento.split("/");
    const data = new Date(`${a}-${m}-${d}`);
    const diff = Math.ceil((data - hoje) / 86400000);
    return diff > 0 && diff <= 7;
  });

  let rel = `📊 *RELATÓRIO DE VENCIMENTOS*\n\n`;

  if (vencidos.length > 0) {
    rel += `🔴 *VENCIDOS (${vencidos.length}):*\n`;
    vencidos.forEach((n) => {
      rel += `• ${n.fornecedor} - R$ ${n.valor.toFixed(2)} - Venceu ${n.vencimento}\n`;
    });
    rel += "\n";
  }

  if (venceHoje.length > 0) {
    rel += `🟠 *VENCEM HOJE (${venceHoje.length}):*\n`;
    venceHoje.forEach((n) => {
      rel += `• ${n.fornecedor} - R$ ${n.valor.toFixed(2)} - ${n.formaPagamento}\n`;
    });
    rel += "\n";
  }

  if (proximos.length > 0) {
    rel += `🟡 *PRÓXIMOS 7 DIAS (${proximos.length}):*\n`;
    proximos.forEach((n) => {
      const [d, m, a] = n.vencimento.split("/");
      const diff = Math.ceil((new Date(`${a}-${m}-${d}`) - hoje) / 86400000);
      rel += `• ${n.fornecedor} - R$ ${n.valor.toFixed(2)} - Vence em ${diff}d (${n.vencimento})\n`;
    });
    rel += "\n";
  }

  const totalPendente = pendentes.reduce((s, n) => s + n.valor, 0);
  rel += `💰 *Total pendente: R$ ${totalPendente.toFixed(2)}*`;

  return rel;
}

// Webhook da Evolution API
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.data || !body.data.message) return;

    const msg = body.data.message;
    const numero = body.data.key?.remoteJid?.replace("@s.whatsapp.net", "");
    if (!numero) return;

    // Mensagem de texto
    if (msg.conversation || msg.extendedTextMessage?.text) {
      const texto = msg.conversation || msg.extendedTextMessage?.text || "";
      const textoLower = texto.toLowerCase();

      // Comandos
      if (textoLower.includes("relatório") || textoLower.includes("relatorio") || textoLower === "r") {
        await enviarMensagem(numero, gerarRelatorioVencimentos());
        return;
      }

      if (textoLower.includes("pago") || textoLower.includes("paguei")) {
        // Marcar como pago pelo nome do fornecedor
        const palavras = texto.split(" ");
        const nomeFornecedor = palavras.slice(1).join(" ").toLowerCase();
        const nota = notas.find((n) => n.fornecedor.toLowerCase().includes(nomeFornecedor) && !n.pago);
        if (nota) {
          nota.pago = true;
          nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
          await enviarMensagem(numero, `✅ Pagamento de *${nota.fornecedor}* - R$ ${nota.valor.toFixed(2)} confirmado!`);
        } else {
          await enviarMensagem(numero, `❌ Fornecedor não encontrado. Digite: *pago [nome do fornecedor]*`);
        }
        return;
      }

      if (textoLower === "ajuda" || textoLower === "menu") {
        await enviarMensagem(
          numero,
          `🏗️ *AGENTE CONSTRUTORA*\n\n📋 *Comandos:*\n\n• Envie uma *foto ou PDF* da NF para lançar\n• *relatório* - ver vencimentos\n• *pago [fornecedor]* - confirmar pagamento\n• *listar* - ver todas as NFs\n• *ajuda* - este menu`
        );
        return;
      }

      if (textoLower === "listar") {
        if (notas.length === 0) {
          await enviarMensagem(numero, "📋 Nenhuma nota fiscal lançada ainda.");
          return;
        }
        let lista = `📋 *NOTAS FISCAIS (${notas.length})*\n\n`;
        notas.slice(-10).forEach((n, i) => {
          lista += `${i + 1}. *${n.fornecedor}*\n   R$ ${n.valor.toFixed(2)} | ${n.vencimento} | ${n.pago ? "✅ Pago" : "⏳ Pendente"}\n\n`;
        });
        await enviarMensagem(numero, lista);
        return;
      }

      // Tentar extrair NF do texto
      await enviarMensagem(numero, "🔍 Analisando nota fiscal...");
      const dados = await extrairDadosNF(texto);
      if (dados && dados.fornecedor) {
        dados.id = Date.now();
        dados.pago = false;
        notas.push(dados);
        await enviarMensagem(
          numero,
          `✅ *NF lançada com sucesso!*\n\n🏢 *Fornecedor:* ${dados.fornecedor}\n📅 *Faturamento:* ${dados.dataFaturamento}\n⏰ *Vencimento:* ${dados.vencimento}\n💰 *Valor:* R$ ${dados.valor?.toFixed(2)}\n🏗️ *Obra:* ${dados.obra || "Não identificada"}\n💳 *Pagamento:* ${dados.formaPagamento || "Não informado"}`
        );
      } else {
        await enviarMensagem(numero, `❓ Não consegui identificar os dados da NF.\n\nEnvie uma *foto* da nota ou digite os dados:\n*Fornecedor | Valor | Vencimento | Obra*`);
      }
    }

    // Mensagem com imagem
    if (msg.imageMessage) {
      await enviarMensagem(numero, "📸 Imagem recebida! Extraindo dados da NF...");
      // Download da imagem via Evolution API
      try {
        const mediaResponse = await axios.post(
          `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
          { message: { key: body.data.key, message: msg } },
          { headers: { apikey: EVOLUTION_API_KEY } }
        );
        const base64 = mediaResponse.data.base64;
        const dados = await extrairDadosNF("", base64);
        if (dados && dados.fornecedor) {
          dados.id = Date.now();
          dados.pago = false;
          notas.push(dados);
          await enviarMensagem(
            numero,
            `✅ *NF lançada com sucesso!*\n\n🏢 *Fornecedor:* ${dados.fornecedor}\n📅 *Faturamento:* ${dados.dataFaturamento}\n⏰ *Vencimento:* ${dados.vencimento}\n💰 *Valor:* R$ ${dados.valor?.toFixed(2)}\n🏗️ *Obra:* ${dados.obra || "Não identificada"}\n💳 *Pagamento:* ${dados.formaPagamento || "Não informado"}`
          );
        } else {
          await enviarMensagem(numero, "❌ Não consegui extrair os dados da imagem. Tente uma foto mais nítida.");
        }
      } catch (err) {
        await enviarMensagem(numero, "❌ Erro ao processar imagem. Tente novamente.");
      }
    }
  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

app.get("/", (req, res) => res.json({ status: "Agente Construtora online ✅" }));

app.listen(PORT, () => console.log(`Agente rodando na porta ${PORT}`));
