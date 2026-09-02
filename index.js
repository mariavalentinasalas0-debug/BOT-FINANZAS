import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import pkg from "@whiskeysockets/baileys";
const makeWASocket = pkg.default || pkg;
const { useMultiFileAuthState, DisconnectReason, Browsers } = pkg;
import QRCode from "qrcode";
import pino from "pino";
import cron from "node-cron";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let qrCodeData = "";
let isConnected = false;
let sock = null;
let reconnectTimer = null;

// ==========================================
// 🗄️ FUNCIONES DE BASE DE DATOS (SUPABASE)
// ==========================================

async function registrarMovimiento({ tipo, monto, categoria, descripcion }) {
  try {
    const { data, error } = await supabase
      .from("movimientos")
      .insert([
        {
          tipo: tipo.toLowerCase(),
          monto: Number(monto),
          categoria: categoria || "Varios",
          descripcion: descripcion || "",
          medio_pago: "Efectivo"
        }
      ])
      .select();

    if (error) throw error;
    return `✅ *${tipo === "egreso" ? "Gasto" : "Ingreso"} registrado:*\n💵 Monto: $${monto}\n🏷️ Categoría: ${categoria || "Varios"}\n📝 Detalle: ${descripcion || "Sin detalle"}`;
  } catch (err) {
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
    return `⏰ *Recordatorio guardado:*\n📌 ${titulo}\n💵 $${monto || "N/A"}\n📅 Vence el ${fecha_vencimiento}`;
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
        return `🎯 Creé la meta *"${meta}"* con $${monto}.`;
      }
      const item = data[0];
      const nuevo = Number(item.monto_actual) + Number(monto);
      await supabase.from("ahorros").update({ monto_actual: nuevo }).eq("id", item.id);
      return `💰 Sumaste $${monto} a *"${item.meta}"*.\nTotal acumulado: $${nuevo}.`;
    }
    const { data } = await supabase.from("ahorros").select("*");
    if (!data?.length) return "Aún no tienes metas de ahorro registradas.";
    let res = data.map((a) => `🎯 *${a.meta}*: $${a.monto_actual}`).join("\n");
    return `💰 *Tus Ahorros:*\n\n${res}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ==========================================
// 🧠 INTELIGENCIA ARTIFICIAL (GEMINI)
// ==========================================

async function procesarConIA(texto) {
  const modelNames = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

  for (const modelName of modelNames) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: `Eres "FinBot", el asistente personal de WhatsApp para finanzas. Sé conciso, amigable y usa emojis. Fecha actual: ${new Date().toISOString().split("T")[0]}.`,
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
                description: "Consulta balance y gastos",
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
      console.error(`Error en modelo ${modelName}:`, error.message);
    }
  }

  return "Ups, tuve un problema temporal al procesar tu mensaje. Intenta de nuevo.";
}

// ==========================================
// 📲 CONEXIÓN WHATSAPP CON BAILEYS (QR)
// ==========================================

async function iniciarWhatsApp() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Desktop"),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      console.log("📲 Código QR listo para escanear!");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      console.log(`Conexión cerrada (${statusCode}). Reconectando en 5 segundos...`);
      if (shouldReconnect) {
        reconnectTimer = setTimeout(() => iniciarWhatsApp(), 5000);
      }
    } else if (connection === "open") {
      isConnected = true;
      qrCodeData = "";
      console.log("🎉 ¡BOT DE WHATSAPP CONECTADO CON ÉXITO!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.remoteJid === "status@broadcast") return;

    const texto = m.message?.conversation || m.message?.extendedTextMessage?.text;
    if (!texto) return;

    const jid = m.key.remoteJid;
    console.log(`📩 Mensaje recibido en (${jid}): "${texto}"`);

    // Procesar con IA
    const respuesta = await procesarConIA(texto);

    // Responder en el mismo chat
    await sock.sendMessage(jid, { text: respuesta });
  });
}

iniciarWhatsApp();

// ==========================================
// 🌐 PÁGINA WEB PARA ESCANEAR EL QR
// ==========================================

app.get("/", (req, res) => {
  if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Bot de Finanzas - Conectado</title>
      </head>
      <body style="font-family:sans-serif; text-align:center; padding:40px; background:#f0f2f5;">
        <div style="background:white; max-width:450px; margin:auto; padding:30px; border-radius:15px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
          <h1 style="color:#25D366; font-size:26px;">🎉 ¡Bot Conectado!</h1>
          <p style="font-size:16px; color:#555;">Tu bot de finanzas está activo las 24 horas.</p>
          <p style="font-size:15px; background:#e7f8ee; color:#128c7e; padding:12px; border-radius:8px;">
            Abre WhatsApp en tu celular y escribe en tu chat <b>"Mensajes contigo mismo"</b>.
          </p>
        </div>
      </body>
      </html>
    `);
  } else if (qrCodeData) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="20">
        <title>Escanear QR de WhatsApp</title>
      </head>
      <body style="font-family:sans-serif; text-align:center; padding:20px; background:#f0f2f5;">
        <div style="background:white; max-width:450px; margin:auto; padding:25px; border-radius:15px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
          <h2 style="color:#075E54; margin-top:0;">📱 Escanea el Código QR</h2>
          <p style="font-size:14px; color:#555; text-align:left; line-height:1.6;">
            1. Abre <b>WhatsApp</b> en tu celular.<br>
            2. Ve a <b>Ajustes > Dispositivos vinculados</b>.<br>
            3. Toca <b>Vincular un dispositivo</b> y apunta a la pantalla:
          </p>
          <img src="${qrCodeData}" style="width:260px; height:260px; border:2px solid #25D366; padding:8px; border-radius:10px;" />
          <p style="color:#888; font-size:12px; margin-top:10px;">(El QR se actualiza automáticamente)</p>
        </div>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="5">
        <title>Iniciando Bot...</title>
      </head>
      <body style="font-family:sans-serif; text-align:center; padding:50px; background:#f0f2f5;">
        <div style="background:white; max-width:400px; margin:auto; padding:30px; border-radius:15px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
          <h3>⏳ Iniciando motor de WhatsApp...</h3>
          <p style="color:#666;">Generando código QR en 5 segundos...</p>
        </div>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
