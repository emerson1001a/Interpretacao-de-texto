import express from "express";
import cors from "cors";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "leituras.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

async function readStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { nextId: 1, leituras: [] };
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function cleanText(value, fallback = "") {
  return (value ?? fallback).toString().trim();
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && content?.text) parts.push(content.text);
      if (content?.type === "text" && content?.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function askOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) return "";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
  }
  return extractOutputText(data);
}

function fallbackText({ idade, tema, tamanho }) {
  const assunto = tema || "amizade e escola";
  const extra = tamanho === "longo"
    ? " No fim do dia, eles perceberam que conversar com calma ajudava a encontrar solucoes melhores."
    : "";
  return `Na turma de uma crianca de ${idade} anos, surgiu uma atividade sobre ${assunto}. No comeco, alguns alunos ficaram inseguros, porque cada pessoa tinha uma ideia diferente. A professora pediu que todos escutassem com atencao antes de responder. Aos poucos, o grupo percebeu que entender o texto era como montar um caminho: primeiro observar os fatos, depois pensar no que estava escondido nas entrelinhas. Quando chegou a vez de explicar, a crianca usou exemplos do texto e conseguiu defender sua opiniao com mais seguranca.${extra}`;
}

function fallbackQuestions(texto) {
  return [
    {
      type: "mcq",
      prompt: "Qual foi a orientacao principal da professora?",
      options: ["Escutar com atencao antes de responder", "Copiar o texto inteiro", "Responder sem pensar", "Ignorar as ideias do grupo"],
      answer_key: "Escutar com atencao antes de responder",
      tags: ["literal"]
    },
    {
      type: "open",
      prompt: "Explique com suas palavras qual foi a principal aprendizagem da crianca.",
      tags: ["inferencia"]
    },
    {
      type: "open",
      prompt: "Escolha uma frase do texto e diga por que ela ajuda a entender a mensagem.",
      tags: ["vocab"]
    }
  ];
}

async function generateText(params) {
  const prompt = `
Crie um texto curto em portugues do Brasil para uma atividade de interpretacao.
Aluno: ${params.aluno}
Idade: ${params.idade}
Tema: ${params.tema || "livre"}
Tamanho: ${params.tamanho || "medio"}

Responda apenas com o texto, sem titulo e sem markdown.
`.trim();

  const generated = await askOpenAI(prompt).catch((error) => {
    console.warn("OpenAI indisponivel em /api/leitura/start:", error.message);
    return "";
  });
  return generated || fallbackText(params);
}

async function generateQuestions(texto) {
  const prompt = `
Crie 4 perguntas de interpretacao para o texto abaixo.
Retorne somente JSON valido neste formato:
{"questions":[{"type":"mcq","prompt":"...","options":["A","B","C","D"],"answer_key":"A","tags":["literal"]},{"type":"open","prompt":"...","tags":["inferencia"]}]}

Texto:
${texto}
`.trim();

  const generated = await askOpenAI(prompt).catch((error) => {
    console.warn("OpenAI indisponivel em /api/leitura/finish-reading:", error.message);
    return "";
  });
  const parsed = parseJsonLoose(generated);
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : fallbackQuestions(texto);
  return questions.slice(0, 5).map((q) => ({
    type: q.type === "mcq" ? "mcq" : "open",
    prompt: cleanText(q.prompt, "Responda com base no texto."),
    options: Array.isArray(q.options) ? q.options.map(String).slice(0, 4) : undefined,
    answer_key: q.answer_key ? String(q.answer_key) : undefined,
    tags: Array.isArray(q.tags) ? q.tags.map(String) : []
  }));
}

function computeMetrics(leitura) {
  const respostas = Array.isArray(leitura.respostas) ? leitura.respostas : [];
  const mcq = respostas.filter((r) => r.correta !== null && r.correta !== undefined);
  const mcqScore = mcq.filter((r) => r.correta === true || r.correta === 1).length;
  const totalTempo = respostas.reduce((sum, r) => sum + (Number(r.tempo_ms) || 0), 0);
  const avgQ = respostas.length ? Math.round(totalTempo / respostas.length) : null;
  return {
    read_ms: leitura.read_time_ms ?? null,
    avg_q_ms: avgQ,
    avg_q_time_ms: avgQ,
    mcq_score: mcqScore,
    mcq_max: mcq.length,
    mcq_accuracy_pct: mcq.length ? Math.round((mcqScore / mcq.length) * 100) : null
  };
}

async function generateFeedback(leitura) {
  const metrics = computeMetrics(leitura);
  const respostas = (leitura.respostas || [])
    .map((r) => `Pergunta ${r.pergunta_index}: ${r.pergunta}\nResposta: ${r.resposta}`)
    .join("\n\n");
  const prompt = `
Crie um feedback curto, gentil e especifico para uma crianca sobre esta atividade de interpretacao.
Texto: ${leitura.texto}
Respostas:
${respostas}
Pontuacao objetiva: ${metrics.mcq_score}/${metrics.mcq_max}
Responda em portugues, sem markdown.
`.trim();

  const generated = await askOpenAI(prompt).catch((error) => {
    console.warn("OpenAI indisponivel em /api/leitura/finish:", error.message);
    return "";
  });
  return generated || `Bom trabalho! Voce concluiu a leitura e respondeu as perguntas. Continue usando partes do texto para justificar suas respostas. Resultado objetivo: ${metrics.mcq_score}/${metrics.mcq_max}.`;
}

app.get("/", (_req, res) => {
  res.type("text/plain; charset=utf-8").send("OK - Interpretacao de Texto backend rodando");
});

app.post("/api/leitura/start", async (req, res) => {
  try {
    const aluno = cleanText(req.body?.aluno, "Miguel") || "Miguel";
    const idade = clampNumber(req.body?.idade, 11, 6, 18);
    const tema = cleanText(req.body?.tema);
    const tamanho = cleanText(req.body?.tamanho, "medio") || "medio";
    const texto = await generateText({ aluno, idade, tema, tamanho });

    const store = await readStore();
    const leitura = {
      id: store.nextId++,
      aluno,
      idade,
      tema,
      tamanho,
      titulo: "Interpretacao de texto",
      texto,
      created_at: new Date().toISOString(),
      read_time_ms: null,
      questions: [],
      respostas: [],
      feedback: ""
    };
    store.leituras.push(leitura);
    await writeStore(store);
    res.json({ leitura_id: leitura.id, texto, config: { idade, tema, tamanho } });
  } catch (error) {
    res.status(500).json({ error: "Erro ao preparar atividade", details: error.message });
  }
});

app.post("/api/leitura/finish-reading", async (req, res) => {
  try {
    const leituraId = Number(req.body?.leitura_id);
    const store = await readStore();
    const leitura = store.leituras.find((item) => item.id === leituraId);
    if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });

    leitura.read_time_ms = Number(req.body?.read_time_ms) || null;
    leitura.questions = await generateQuestions(leitura.texto);
    await writeStore(store);
    res.json({ questions: leitura.questions });
  } catch (error) {
    res.status(500).json({ error: "Erro ao gerar perguntas", details: error.message });
  }
});

app.post("/api/leitura/answer", async (req, res) => {
  const leituraId = Number(req.body?.leitura_id);
  const store = await readStore();
  const leitura = store.leituras.find((item) => item.id === leituraId);
  if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });

  leitura.respostas.push({
    pergunta_index: Number(req.body?.pergunta_index) || null,
    pergunta: cleanText(req.body?.pergunta),
    resposta: cleanText(req.body?.resposta),
    correta: req.body?.correta ?? null,
    tempo_ms: Number(req.body?.tempo_ms) || null,
    tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []
  });
  await writeStore(store);
  res.json({ ok: true });
});

app.post("/api/leitura/finish", async (req, res) => {
  try {
    const leituraId = Number(req.body?.leitura_id);
    const store = await readStore();
    const leitura = store.leituras.find((item) => item.id === leituraId);
    if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });

    leitura.feedback = await generateFeedback(leitura);
    await writeStore(store);
    res.json({ feedback: leitura.feedback, metrics: computeMetrics(leitura) });
  } catch (error) {
    res.status(500).json({ error: "Erro ao gerar feedback", details: error.message });
  }
});

app.get("/api/leitura/resumo", async (req, res) => {
  const aluno = cleanText(req.query?.aluno, "Miguel") || "Miguel";
  const idade = clampNumber(req.query?.idade, 11, 6, 18);
  const limit = clampNumber(req.query?.limit, 30, 1, 200);
  const store = await readStore();
  const sessoes = store.leituras
    .filter((item) => item.aluno === aluno && Number(item.idade) === idade)
    .slice(-limit)
    .reverse()
    .map((item) => ({
      id: item.id,
      created_at: item.created_at,
      read_time_ms: item.read_time_ms,
      total_questions: item.questions?.length ?? 0,
      feedback: item.feedback,
      ...computeMetrics(item)
    }));
  res.json({ aluno, idade, sessoes });
});

app.get("/api/leitura/detalhe", async (req, res) => {
  const leituraId = Number(req.query?.id);
  const store = await readStore();
  const leitura = store.leituras.find((item) => item.id === leituraId);
  if (!leitura) return res.status(404).json({ error: "Sessao nao encontrada" });
  res.json({
    leitura,
    respostas: leitura.respostas || [],
    metrics: computeMetrics(leitura)
  });
});

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

export default app;
