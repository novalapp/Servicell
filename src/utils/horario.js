// Horario de atención de Servicell, compartido entre el webhook
// (mensajes fijos con hora correcta) y la IA (para que sepa si está
// abierto o cerrado sin tener que adivinar la hora).
//
// También revisa un interruptor manual (agent_config.forzar_disponible)
// para los momentos en que el equipo SÍ puede responder aunque esté
// fuera del horario fijo — lo prenden/apagan desde el panel.

const supabase = require('../config/database');

const HORARIO_SEMANA  = { apertura: 570, cierre: 1140 }; // lunes a sábado
const HORARIO_DOMINGO = { apertura: 600, cierre: 960 };  // domingos y festivos

const MARGEN_CIERRE_MIN = 30;

// Festivos colombianos, formato 'YYYY-MM-DD'
const FESTIVOS = [];

function ahoraColombia() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(new Date());

  const valor = tipo => partes.find(p => p.type === tipo)?.value;

  return {
    hora: parseInt(valor('hour'), 10) % 24,
    minuto: parseInt(valor('minute'), 10)
  };
}

function infoDia(offsetDias) {
  const fecha = new Date(Date.now() + offsetDias * 86400000);

  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(fecha);

  const valor = tipo => partes.find(p => p.type === tipo)?.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    fecha: `${valor('year')}-${valor('month')}-${valor('day')}`,
    dia: dias[valor('weekday')]
  };
}

function horarioDe(offsetDias) {
  const { fecha, dia } = infoDia(offsetDias);
  const comoDomingo = (dia === 0) || FESTIVOS.includes(fecha);
  return comoDomingo ? HORARIO_DOMINGO : HORARIO_SEMANA;
}

function formatHora(minutos) {
  const h24 = Math.floor(minutos / 60);
  const m = minutos % 60;
  const sufijo = h24 >= 12 ? 'pm' : 'am';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${sufijo}` : `${h12}:${String(m).padStart(2, '0')}${sufijo}`;
}

// Interruptor manual: si está prendido, el equipo dijo que SÍ puede
// responder ahora mismo, sin importar el horario fijo. Si falla la
// consulta por lo que sea, sigue con el horario normal — nunca debe
// tumbar un mensaje por esto.
async function estaForzadoDisponible(clientId) {
  if (!clientId) return false;
  try {
    const { data, error } = await supabase
      .from('agent_config')
      .select('forzar_disponible')
      .eq('client_id', clientId)
      .eq('active', true)
      .limit(1);

    if (error) throw new Error(error.message);
    return !!(data && data[0] && data[0].forzar_disponible);
  } catch (err) {
    console.error('⚠️ No pude revisar forzar_disponible, sigo con el horario normal:', err.message);
    return false;
  }
}

async function estadoAtencion(clientId) {
  if (await estaForzadoDisponible(clientId)) {
    return { estado: 'abierto', apertura: horarioDe(0).apertura, forzado: true };
  }

  const { hora, minuto } = ahoraColombia();
  const ahora = hora * 60 + minuto;
  const hoy = horarioDe(0);

  if (ahora < hoy.apertura) {
    return { estado: 'temprano', apertura: hoy.apertura, minutosParaAbrir: hoy.apertura - ahora };
  }
  if (ahora >= hoy.cierre - MARGEN_CIERRE_MIN) {
    return { estado: 'cerrado', apertura: horarioDe(1).apertura };
  }
  return { estado: 'abierto', apertura: hoy.apertura };
}

// Frase corta para inyectarle a la IA, sin que tenga que adivinar la hora.
async function fraseEstadoAtencion(clientId) {
  const atencion = await estadoAtencion(clientId);
  if (atencion.estado === 'abierto') return 'Estamos abiertos ahora mismo.';
  const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
  return `Estamos cerrados en este momento. Abrimos ${dia} a partir de las ${formatHora(atencion.apertura)}.`;
}

module.exports = { estadoAtencion, formatHora, fraseEstadoAtencion };
