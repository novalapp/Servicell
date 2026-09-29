// Horario de atención de Servicell, compartido entre el webhook
// (mensajes fijos con hora correcta) y la IA (para que sepa si está
// abierto o cerrado sin tener que adivinar la hora).

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

function estadoAtencion() {
  const { hora, minuto } = ahoraColombia();
  const ahora = hora * 60 + minuto;
  const hoy = horarioDe(0);

  if (ahora < hoy.apertura) return { estado: 'temprano', apertura: hoy.apertura };
  if (ahora >= hoy.cierre - MARGEN_CIERRE_MIN) {
    return { estado: 'cerrado', apertura: horarioDe(1).apertura };
  }
  return { estado: 'abierto', apertura: hoy.apertura };
}

// Frase corta para inyectarle a la IA, sin que tenga que adivinar la hora.
function fraseEstadoAtencion() {
  const atencion = estadoAtencion();
  if (atencion.estado === 'abierto') return 'Estamos abiertos ahora mismo.';
  const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
  return `Estamos cerrados en este momento. Abrimos ${dia} a partir de las ${formatHora(atencion.apertura)}.`;
}

module.exports = { estadoAtencion, formatHora, fraseEstadoAtencion };
