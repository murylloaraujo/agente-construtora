const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "50mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const PORT = process.env.PORT || 3000;

let notas = [];

async function enviarMensagem(numero, mensagem) {
  try {
    const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
    await axios.post(
      url,
      {
        number: numero,
        text: mensagem,
      },
      {
        headers: {
          apikey: EVOLUTION_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Mensagem enviada para", numero);
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.response?.data || err.message);
  }
}

async function extrairDadosNF(texto, imagemBase64 = null) {
  try {
    const content = [];

    if (imagemBase64) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imagemBase64 },
      });
    }

    content.push({
      type: "text",
      text: `Você é um assistente especializado em notas fiscais brasileiras.
Extraia os dados da nota fiscal e retorne APENAS um JSON válido, sem explicações, sem markdown.

${texto ? "Texto: " + texto : ""}

Formato:
{"fornecedor":"nome","dataFaturamento":"DD/MM/AAAA","vencimento":"DD/MM/AAAA","valor":0.00,"obra":"nome da obra","formaPagamento":"PIX ou Boleto ou Deposito","numeroNF":"numero"}

Se não encontrar algum campo, use null.`,
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
    console.log("Resposta IA:", texto_resposta);
    const json_match = texto_resposta.match(/\{[\s\S]*\}/);
    if (json_match) return JSON.parse(json_match[0]);
    return null;
  } catch (err) {
    console.error("Erro ao extrair dados NF:", err.response?.data || err.message);
    return null;
  }
}

function gerarRelatorioVencimentos() {
  const hoje = new Date();
  const pendentes = notas.filter((n) => !n.pago);

  if (pendentes.length === 0) return "✅ Nenhum pagamento pendente.";

  const vencidos = pendentes.filter((n) => {
    if (!n.vencimento) return false;
    const [d, m, a] = n.vencimento.split("/");
    return new Date(`${a}-${m}-${d}`) < hoje;
  });

  const proximos = pendentes.filter((n) => {
    if (!n.vencimento) return false;
    const [d, m, a] = n.vencimento.split("/");
    const data = new Date(`${a}-${m}-${d}`);
    const diff = Math.ceil((data - hoje) / 86400000);
    return diff >= 0 && diff <= 7;
  });

  let rel = `📊 *RELATÓRIO DE VENCIMENTOS*\n\n`;

  if (vencidos.length > 0) {
    rel += `🔴 *VENCIDOS (${vencidos.length}):*\n`;
    vencidos.forEach((n) => {
      rel += `• ${n.fornecedor} - R$ ${Number(n.valor).toFixed(2)} - Venceu ${n.vencimento}\n`;
    });
    rel += "\n";
  }

  if (proximos.length > 0) {
    rel += `🟡 *PRÓXIMOS 7 DIAS (${proximos.length}):*\n`;
    proximos.forEach((n) => {
      const [d, m, a] = n.vencimento.split("/");
      const diff = Math.ceil((new Date(`${a}-${m}-${d}`) - hoje) / 86400000);
      rel += `• ${n.fornecedor} - R$ ${Number(n.valor).toFixed(2)} - Vence em ${diff}d (${n.vencimento})\n`;
    });
    rel += "\n";
  }

  const totalPendente = pendentes.reduce((s, n) => s + Number(n.valor || 0), 0);
  rel += `💰 *Total pendente: R$ ${totalPendente.toFixed(2)}*`;

  return rel;
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("Webhook recebido:", JSON.stringify(body).substring(0, 200));

    if (!body.data || !body.data.message) return;

    const msg = body.data.message;
    const remoteJid = body.data.key?.remoteJid || "";
    const numero = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
    const fromMe = body.data.key?.fromMe;

    if (!numero || fromMe) return;

    const texto = msg.conversation || msg.extendedTextMessage?.text || "";
    const textoLower = texto.toLowerCase().trim();

    console.log("Mensagem de:", numero, "Texto:", texto);

    if (textoLower === "ajuda" || textoLower === "menu") {
      await enviarMensagem(numero,
        `🏗️ *AGENTE CONSTRUTORA*\n\n📋 *Comandos disponíveis:*\n\n• Envie uma *foto* da NF para lançar\n• *relatorio* - ver vencimentos\n• *pago [fornecedor]* - confirmar pagamento\n• *listar* - ver todas as NFs\n• *ajuda* - este menu`
      );
      return;
    }

    if (textoLower === "relatorio" || textoLower === "relatório") {
      await enviarMensagem(numero, gerarRelatorioVencimentos());
      return;
    }

    if (textoLower === "listar") {
      if (notas.length === 0) {
        await enviarMensagem(numero, "📋 Nenhuma nota fiscal lançada ainda.");
        return;
      }
      let lista = `📋 *NOTAS FISCAIS (${notas.length})*\n\n`;
      notas.slice(-10).forEach((n, i) => {
        lista += `${i + 1}. *${n.fornecedor}*\n   R$ ${Number(n.valor).toFixed(2)} | ${n.vencimento} | ${n.pago ? "✅ Pago" : "⏳ Pendente"}\n\n`;
      });
      await enviarMensagem(numero, lista);
      return;
    }

    if (textoLower.startsWith("pago ")) {
      const nomeFornecedor = texto.substring(5).toLowerCase();
      const nota = notas.find((n) => n.fornecedor?.toLowerCase().includes(nomeFornecedor) && !n.pago);
      if (nota) {
        nota.pago = true;
        nota.dataPagamento = new Date().toLocaleDateString("pt-BR");
        await enviarMensagem(numero, `✅ Pagamento de *${nota.fornecedor}* - R$ ${Number(nota.valor).toFixed(2)} confirmado!`);
      } else {
        await enviarMensagem(numero, `❌ Fornecedor não encontrado.\n\nDigite: *pago [nome do fornecedor]*`);
      }
      return;
    }

    if (msg.imageMessage) {
      await enviarMensagem(numero, "📸 Imagem recebida! Analisando NF...");
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
          await enviarMensagem(numero,
            `✅ *NF lançada!*\n\n🏢 *Fornecedor:* ${dados.fornecedor}\n📅 *Faturamento:* ${dados.dataFaturamento}\n⏰ *Vencimento:* ${dados.vencimento}\n💰 *Valor:* R$ ${Number(dados.valor).toFixed(2)}\n🏗️ *Obra:* ${dados.obra || "Não identificada"}\n💳 *Pagamento:* ${dados.formaPagamento || "Não informado"}`
          );
        } else {
          await enviarMensagem(numero, "❌ Não consegui extrair os dados. Tente uma foto mais nítida.");
        }
      } catch (err) {
        console.error("Erro imagem:", err.message);
        await enviarMensagem(numero, "❌ Erro ao processar imagem.");
      }
      return;
    }

    if (texto.length > 10) {
      await enviarMensagem(numero, "🔍 Analisando nota fiscal...");
      const dados = await extrairDadosNF(texto);
      if (dados && dados.fornecedor) {
        dados.id = Date.now();
        dados.pago = false;
        notas.push(dados);
        await enviarMensagem(numero,
          `✅ *NF lançada!*\n\n🏢 *Fornecedor:* ${dados.fornecedor}\n📅 *Faturamento:* ${dados.dataFaturamento}\n⏰ *Vencimento:* ${dados.vencimento}\n💰 *Valor:* R$ ${Number(dados.valor).toFixed(2)}\n🏗️ *Obra:* ${dados.obra || "Não identificada"}\n💳 *Pagamento:* ${dados.formaPagamento || "Não informado"}`
        );
      } else {
        await enviarMensagem(numero,
          `❓ Não identifiquei uma NF.\n\nDigite *ajuda* para ver os comandos disponíveis.`
        );
      }
    }

  } catch (err) {
    console.error("Erro geral webhook:", err.message);
  }
});

app.get("/", (req, res) => res.json({ status: "Agente Construtora online ✅", notas: notas.length }));

app.listen(PORT, () => console.log(`Agente rodando na porta ${PORT}`));
