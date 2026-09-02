import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type } from "@google/genai";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(express.json());

// Variables de entorno
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto_finanzas";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const USER_PHONE_NUMBER = process.env.USER_PHONE_NUMBER;

// Inicialización de Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Inicialización de Gemini
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ==========================================
// 🛠️ HERRAMIENTAS / FUNCIONES DE FINANZAS
// ==========================================

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
    return {
      status: "success",
      mensaje: `✅ ${tipo === "egreso" ? "Gasto" : "Ingreso"} registrado con éxito.`,
      registro: data[0]
    };
  } catch (err) {
    console.error("Error registrando movimiento:", err);
    return { status: "error", error: err.message };
  }
}

async function consultarResumen({ periodo }) {
  try {
    const now = new Date();
    let startDate = new Date();

    if (periodo === "hoy") {
      startDate.setHours(0, 0, 0, 0);
    } else if (periodo === "este_mes") {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (periodo === "ultimo_mes") {
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
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
    const categoriasEgresos = {};

    data.forEach((m) => {
      const monto = Number(m.monto);
      if (m.tipo === "ingreso") {
        totalIngresos += monto;
      } else if (m.tipo === "egreso") {
        totalEgresos += monto;
        categoriasEgresos[m.categoria] = (categoriasEgresos[m.categoria] || 0) + monto;
      }
    });

    const balance = totalIngresos - totalEgresos;

    return {
      status: "success",
      periodo: periodo || "este_mes",
      totalIngresos,
      totalEgresos,
      balance,
      gastosPorCategoria: categoriasEgresos,
      cantidadMovimientos: data.length
    };
  } catch (err) {
    console.error("Error consultando resumen:", err);
    return { status: "error", error: err.message };
  }
}

async function crearRecordatorio({ titulo, monto, fecha_vencimiento }) {
  try {
    const { data, error } = await supabase
      .from("recordatorios")
      .insert([
        {
          titulo,
          monto: monto ? Number(monto) : null,
          fecha_vencimiento
        }
      ])
      .select();

    if (error) throw error;
    return {
      status: "success",
      mensaje: "⏰ Recordatorio guardado correctamente.",
      recordatorio: data[0]
    };
  } catch (err) {
    console.error("Error creando recordatorio:", err);
    return { status: "error", error: err.message };
  }
}

async function consultarRecordatorios({ solo_pendientes }) {
  try {
    let query = supabase.from("recordatorios").select("*").order("fecha_vencimiento", { ascending: true });
    if (solo_pendientes !== false) {
      query = query.eq("pagado", false);
    }
    const { data, error } = await query;
    if (error) throw error;

    return {
      status: "success",
      recordatorios: data
    };
  } catch (err) {
    console.error("Error consultando recordatorios:", err);
    return { status: "error", error: err.message };
  }
}

async function marcarRecordatorioPagado({ id, titulo }) {
  try {
    let query = supabase.from("recordatorios").update({ pagado: true });
    if (id) {
      query = query.eq("id", id);
    } else if (titulo) {
      query = query.ilike("titulo", `%${titulo}%`);
    }

    const { data, error } = await query.select();
    if (error) throw error;

    return {
      status: "success",
      mensaje: "🎉 Recordatorio marcado como pagado.",
      actualizados: data
    };
  } catch (err) {
    console.error("Error actualizando recordatorio:", err);
    return { status: "error", error: err.message };
  }
}

async function gestionarAhorro({ accion, meta, monto, monto_objetivo }) {
  try {
    if (accion === "crear") {
      const { data, error } = await supabase
        .from("ahorros")
        .insert([{ meta, monto_objetivo: monto_objetivo || 0, monto_actual: monto || 0 }])
        .select();
      if (error) throw error;
      return { status: "success", mensaje: `🎯 Meta "${meta}" creada con éxito.`, meta: data[0] };
    }

    if (accion === "sumar") {
      const { data: metasExistentes, error: errBusq } = await supabase
        .from("ahorros")
        .select("*")
        .ilike("meta", `%${meta}%`)
        .limit(1);

      if (errBusq || !metasExistentes.length) {
        return { status: "not_found", mensaje: `No encontré la meta de ahorro "${meta}".` };
      }

      const item = metasExistentes[0];
      const nuevoMonto = Number(item.monto_actual) + Number(monto);

      const { data, error } = await supabase
        .from("ahorros")
        .update({ monto_actual: nuevoMonto })
        .eq("id", item.id)
        .select();

      if (error) throw error;
      return { status: "success", mensaje: `💰 Sumaste $${monto} a "${item.meta}". Nuevo total: $${nuevoMonto}.`, meta: data[0] };
    }

    const { data, error } = await supabase.from("ahorros").select("*");
    if (error) throw error;
    return { status: "success", ahorros: data };
  } catch (err) {
    console.error("Error gestionando ahorro:", err);
    return { status: "error", error: err.message };
  }
}

// Configuración de Tools para Gemini
const toolsConfig = [
  {
    functionDeclarations: [
      {
        name: "registrarMovimiento",
        description: "Registra un nuevo gasto (egreso) o ingreso de dinero.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            tipo: { type: Type.STRING, description: "'ingreso' o 'egreso'", enum: ["ingreso", "egreso"] },
            monto: { type: Type.NUMBER, description: "Cantidad numérica del gasto o ingreso" },
            categoria: { type: Type.STRING, description: "Ej: Supermercado, Comida, Transporte, Servicios, Sueldo, Salud, Salidas, etc." },
            descripcion: { type: Type.STRING, description: "Detalle o motivo breve del movimiento" },
            medio_pago: { type: Type.STRING, description: "Efectivo, Tarjeta de Débito, Tarjeta de Crédito, Transferencia, MercadoPago, etc." }
          },
          required: ["tipo", "monto"]
        }
      },
      {
        name: "consultarResumen",
        description: "Obtiene el balance general, total de ingresos, gastos y desglose por categorías.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            periodo: { type: Type.STRING, description: "'hoy', 'este_mes' o 'ultimo_mes'", enum: ["hoy", "este_mes", "ultimo_mes"] }
          }
        }
      },
      {
        name: "crearRecordatorio",
        description: "Guarda un recordatorio de pago futuro o vencimiento de factura.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            titulo: { type: Type.STRING, description: "Nombre del servicio, tarjeta o deuda a pagar (ej: Tarjeta Visa, Internet Fibertel)" },
            monto: { type: Type.NUMBER, description: "Monto a pagar si se conoce" },
            fecha_vencimiento: { type: Type.STRING, description: "Fecha en formato AAAA-MM-DD (ej: 2026-09-10)" }
          },
          required: ["titulo", "fecha_vencimiento"]
        }
      },
      {
        name: "consultarRecordatorios",
        description: "Lista los recordatorios o pagos pendientes y vencimientos.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            solo_pendientes: { type: Type.BOOLEAN, description: "Si es true solo devuelve los no pagados" }
          }
        }
      },
      {
        name: "marcarRecordatorioPagado",
        description: "Marca un recordatorio de pago como completado o pagado.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            titulo: { type: Type.STRING, description: "Nombre aproximado del recordatorio a marcar como pagado" }
          },
          required: ["titulo"]
        }
      },
      {
        name: "gestionarAhorro",
        description: "Permite crear metas de ahorro, sumar dinero a un ahorro existente o consultar el estado de los ahorros.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            accion: { type: Type.STRING, enum: ["crear", "sumar", "consultar"] },
            meta: { type: Type.STRING, description: "Nombre de la meta (ej: Vacaciones, Auto, Fondo Emergencia)" },
            monto: { type: Type.NUMBER, description: "Monto a sumar o aportar" },
            monto_objetivo: { type: Type.NUMBER, description: "Monto total objetivo al crear la meta" }
          },
          required: ["accion"]
        }
      }
    ]
  }
];

// Procesador con Gemini
async function procesarMensajeConIA(textoUsuario) {
  const systemInstruction = `Eres "FinBot", un asistente personal de finanzas de WhatsApp inteligente, claro, amigable y muy conciso.
Hoy es ${new Date().toISOString().split("T")[0]}.
Tu objetivo es ayudar al usuario a registrar gastos, ingresos, metas de ahorro y recordatorios de vencimiento.
Instrucciones:
1. Usa las herramientas provistas para registrar o consultar datos siempre que el usuario mencione números, compras, sueldos, vencimientos o ahorros.
2. Si el usuario te saluda o hace preguntas generales sobre sus finanzas, responde de forma cálida y breve con emojis.
3. Formatea las respuestas con negritas, emojis y saltos de línea legibles para WhatsApp.
4. Si falta la fecha en un recordatorio como "el 10", calcula la fecha AAAA-MM-DD correspondiente al mes actual o siguiente.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: textoUsuario,
      config: {
        systemInstruction,
        tools: toolsConfig
      }
    });

    const candidate = response.candidates?.[0];
    const functionCalls = candidate?.content?.parts?.filter((p) => p.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      const toolResults = [];

      for (const call of functionCalls) {
        const { name, args } = call.functionCall;
        console.log(`🤖 Ejecutando herramienta: ${name}`, args);

        let result = null;
        if (name === "registrarMovimiento") result = await registrarMovimiento(args);
        else if (name === "consultarResumen") result = await consultarResumen(args);
        else if (name === "crearRecordatorio") result = await crearRecordatorio(args);
        else if (name === "consultarRecordatorios") result = await consultarRecordatorios(args);
        else if (name === "marcarRecordatorioPagado") result = await marcarRecordatorioPagado(args);
        else if (name === "gestionarAhorro") result = await gestionarAhorro(args);

        toolResults.push({
          functionResponse: {
            name,
            response: result
          }
        });
      }

      const followUp = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          { role: "user", parts: [{ text: textoUsuario }] },
          candidate.content,
          { role: "user", parts: toolResults }
        ],
        config: {
          systemInstruction
        }
      });

      return followUp.text || "¡Listo! Acción completada.";
    }

    return response.text || "Disculpa, ¿podrías repetirme eso?";
  } catch (error) {
    console.error("Error en Gemini:", error);
    return "Ups, tuve un problema al procesar tu mensaje. Por favor intenta de nuevo en unos segundos.";
  }
}

// Envío a WhatsApp
async function enviarMensajeWhatsApp(to, texto) {
  try {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: texto }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Error al enviar WhatsApp:", data);
    }
    return data;
  } catch (error) {
    console.error("Error en fetch WhatsApp:", error);
  }
}

// Webhook GET (Verificación)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook POST (Mensajes)
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message && message.type === "text") {
        const from = message.from;
        const textoUsuario = message.text.body;

        console.log(`📩 De ${from}: "${textoUsuario}"`);
        const respuestaBot = await procesarMensajeConIA(textoUsuario);
        await enviarMensajeWhatsApp(from, respuestaBot);
      }
    }
  } catch (error) {
    console.error("Error webhook:", error);
  }
});

app.get("/", (req, res) => {
  res.send("🤖 Bot de Finanzas Personal está ACTIVO 24/7!");
});

// Recordatorios a las 9 AM
cron.schedule("0 9 * * *", async () => {
  if (!USER_PHONE_NUMBER) return;

  try {
    const hoy = new Date().toISOString().split("T")[0];
    const { data: recordatoriosHoy, error } = await supabase
      .from("recordatorios")
      .select("*")
      .eq("fecha_vencimiento", hoy)
      .eq("pagado", false);

    if (error) throw error;

    if (recordatoriosHoy && recordatoriosHoy.length > 0) {
      let mensaje = `🔔 *¡RECORDATORIOS DE HOY (${hoy})!*\n\n`;
      recordatoriosHoy.forEach((r, idx) => {
        mensaje += `${idx + 1}. 📌 *${r.titulo}* ${r.monto ? `- $${r.monto}` : ""}\n`;
      });
      mensaje += `\nPara marcar como pagado: _"Ya pagué [nombre]"_`;

      await enviarMensajeWhatsApp(USER_PHONE_NUMBER, mensaje);
    }
  } catch (err) {
    console.error("Error en cron recordatorios:", err);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
