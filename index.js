import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto_finanzas";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const USER_PHONE_NUMBER = process.env.USER_PHONE_NUMBER;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Funciones de base de datos
async function registrarMovimiento({ tipo, monto, categoria, descripcion, medio_pago }) {
  try {
    const { data, error } = await supabase
      .from("movimientos")
      .insert([
        {
          tipo: tipo.toLowerCase(),
          monto: Number(monto),
          categoria: categoria || "Varios",
          descripcion: descripcion || "",
          medio_pago: medio_pago || "Efectivo"
        }
      ])
      .select();

    if (error) throw error;
    return `✅ ${tipo === "egreso" ? "Gasto" : "Ingreso"} de $${monto} registrado en ${categoria || "Varios"}.`;
  } catch (err) {
    console.error("Error registrando:", err);
    return `Error al registrar: ${err.message}`;
  }
}

async function consultarResumen({ periodo }) {
  try {
    const now = new Date();
    let startDate = new Date();

    if (periodo === "hoy") {
      startDate.setHours(0, 0, 0, 0);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const { data, error } = await supabase
      .from("movimientos")
      .select("*")
      .gte("fecha", startDate.toISOString());

    if (error) throw error;

    let totalIngresos = 0;
    let totalEgresos = 0;
    const catGastos = {};

    data.forEach((m) => {
      const monto = Number(m.monto);
      if (m.tipo === "ingreso") totalIngresos += monto;
      if (m.tipo === "egreso") {
        totalEgresos += monto;
        catGastos[m.categoria] = (catGastos[m.categoria] || 0) + monto;
      }
    });

    let desglose = Object.entries(catGastos)
      .map(([cat, total]) => `  • ${cat}: $${total}`)
      .join("\n");

    return `📊 *Resumen (${periodo || "este mes"}):*\n💵 Ingresos: $${totalIngresos}\n💸 Gastos: $${totalEgresos}\n💰 Balance: $${totalIngresos - totalEgresos}\n\n*Gastos por categoría:*\n${desglose || "Sin gastos registrados aún"}`;
  } catch (err) {
    return `Error al consultar: ${err.message}`;
  }
}

async function crearRecordatorio({ titulo, monto, fecha_vencimiento }) {
  try {
    const { error } = await supabase
      .from("recordatorios")
      .insert([{ titulo, monto: monto ? Number(monto) : null, fecha_vencimiento }]);
    if (error) throw error;
    return `⏰ Recordatorio de "${titulo}" guardado para el ${fecha_vencimiento}.`;
  } catch (err) {
    return `Error al guardar recordatorio: ${err.message}`;
  }
}

async function consultarRecordatorios() {
  try {
    const { data, error } = await supabase
      .from("recordatorios")
      .select("*")
      .eq("pagado", false)
      .order("fecha_vencimiento", { ascending: true });

    if (error) throw error;
    if (!data.length) return "🎉 ¡No tienes pagos pendientes!";

    let lista = data.map((r) => `📌 *${r.titulo}* - $${r.monto || "N/A"} (Vence: ${r.fecha_vencimiento})`).join("\n");
    return `⏰ *Pagos pendientes:*\n\n${lista}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function marcarPagado({ titulo }) {
  try {
    const { data, error } = await supabase
      .from("recordatorios")
      .update({ pagado: true })
      .ilike("titulo", `%${titulo}%`)
      .select();

    if (error) throw error;
    return `🎉 ¡Listo! Marqué como pagado: ${data?.[0]?.titulo || titulo}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function gestionarAhorro({ accion, meta, monto }) {
  try {
    if (accion === "sumar") {
      const { data } = await supabase.from("ahorros").select("*").ilike("meta", `%${meta}%`).limit(1);
      if (!data?.length) {
        await supabase.from("ahorros").insert([{ meta, monto_actual: Number(monto) }]);
        return `🎯 Creé la meta "${meta}" con $${monto}.`;
      }
      const item = data[0];
      const nuevo = Number(item.monto_actual) + Number(monto);
      await supabase.from("ahorros").update({ monto_actual: nuevo }).eq("id", item.id);
      return `💰 Sumaste $${monto} a "${item.meta}". Total acumulado: $${nuevo}.`;
    }
    const { data } = await supabase.from("ahorros").select("*");
    if (!data?.length) return "Aún no tienes metas de ahorro registradas.";
    let res = data.map((a) => `🎯 *${a.meta}*: $${a.monto_actual}`).join("\n");
    return `💰 *Tus Ahorros:*\n\n${res}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// IA con Gemini
async function procesarConIA(texto) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tools: [
        {
          functionDeclarations: [
            {
              name: "registrarMovimiento",
              description: "Registra un gasto o ingreso",
              parameters: {
                type: "OBJECT",
                properties: {
                  tipo: { type: "STRING", enum: ["ingreso", "egreso"] },
                  monto: { type: "NUMBER" },
                  categoria: { type: "STRING" },
                  descripcion: { type: "STRING" }
                },
                required: ["tipo", "monto"]
              }
            },
            {
              name: "consultarResumen",
              description: "Consulta el balance y gastos",
              parameters: {
                type: "OBJECT",
                properties: {
                  periodo: { type: "STRING", enum: ["hoy", "este_mes"] }
                }
              }
            },
            {
              name: "crearRecordatorio",
              description: "Crea recordatorio de pago",
              parameters: {
                type: "OBJECT",
                properties: {
                  titulo: { type: "STRING" },
                  monto: { type: "NUMBER" },
                  fecha_vencimiento: { type: "STRING", description: "AAAA-MM-DD" }
                },
                required: ["titulo", "fecha_vencimiento"]
              }
            },
            {
              name: "consultarRecordatorios",
              description: "Consulta pagos pendientes",
              parameters: { type: "OBJECT", properties: {} }
            },
            {
              name: "marcarPagado",
              description: "Marca servicio como pagado",
              parameters: {
                type: "OBJECT",
                properties: { titulo: { type: "STRING" } },
                required: ["titulo"]
              }
            },
            {
              name: "gestionarAhorro",
              description: "Gestiona metas de ahorro",
              parameters: {
                type: "OBJECT",
                properties: {
                  accion: { type: "STRING", enum: ["sumar", "consultar"] },
                  meta: { type: "STRING" },
                  monto: { type: "NUMBER" }
                },
                required: ["accion"]
              }
            }
          ]
        }
      ]
    });

    const chat = model.startChat();
    const result = await chat.sendMessage(texto);
    const call = result.response.functionCalls()?.[0];

    if (call) {
      let output = "";
      if (call.name === "registrarMovimiento") output = await registrarMovimiento(call.args);
      else if (call.name === "consultarResumen") output = await consultarResumen(call.args);
      else if (call.name === "crearRecordatorio") output = await crearRecordatorio(call.args);
      else if (call.name === "consultarRecordatorios") output = await consultarRecordatorios();
      else if (call.name === "marcarPagado") output = await marcarPagado(call.args);
      else if (call.name === "gestionarAhorro") output = await gestionarAhorro(call.args);

      return output;
    }

    return result.response.text();
  } catch (error) {
    console.error("Error IA:", error);
    return "Ups, tuve un inconveniente al procesar tu mensaje. Intenta de nuevo.";
  }
}

async function enviarWhatsApp(to, texto) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: texto }
      })
    });
  } catch (err) {
    console.error("Error enviando WhatsApp:", err);
  }
}

// Webhook GET
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Webhook POST
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg?.type === "text") {
      const from = msg.from;
      const texto = msg.text.body;
      const respuesta = await procesarConIA(texto);
      await enviarWhatsApp(from, respuesta);
    }
  } catch (e) {
    console.error("Error webhook POST:", e);
  }
});

app.get("/", (req, res) => res.send("🤖 Bot de Finanzas ACTIVO 24/7!"));

// Cron Recordatorios
cron.schedule("0 9 * * *", async () => {
  if (!USER_PHONE_NUMBER) return;
  try {
    const hoy = new Date().toISOString().split("T")[0];
    const { data } = await supabase.from("recordatorios").select("*").eq("fecha_vencimiento", hoy).eq("pagado", false);
    if (data?.length) {
      let txt = `🔔 *¡RECORDATORIOS DE HOY (${hoy})!*\n\n` + data.map((r) => `📌 ${r.titulo} - $${r.monto || ""}`).join("\n");
      await enviarWhatsApp(USER_PHONE_NUMBER, txt);
    }
  } catch (e) {
    console.error("Error cron:", e);
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
