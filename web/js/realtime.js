// Tempo real com Supabase Realtime + plano B por polling.
//
// Estratégia: o evento do Realtime NÃO é usado como fonte de dados — ele só
// avisa "algo mudou". Aí buscamos a lista atualizada na API (debounce de
// 300 ms). Assim nunca há estado divergente, mesmo se um evento se perder.
// Se o WebSocket cair, um polling a cada 20 s mantém a tela correta.

/* global supabase */ // vem de /vendor/supabase.js (UMD)

export function createSupabase(cfg) {
  return supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'padaria-staff-auth' },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

/**
 * Observa pedidos/itens/produtos e chama onChange (com debounce).
 * onStatus recebe 'online' | 'offline' para mostrar o indicador na tela.
 */
export function watchOrders(sb, { onChange, onStatus, onNewOrder, tables = ['orders', 'order_items'], establishmentId }) {
  let timer = null;
  let pollTimer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, 300); };

  // Cada loja escuta só o próprio canal e só as linhas dela. O banco (RLS)
  // já bloqueia linhas de outras lojas; o filtro é uma segunda barreira e
  // economiza tráfego.
  let channel = sb.channel(`padaria-pedidos-${establishmentId ?? 'x'}`);
  for (const table of tables) {
    const spec = { event: '*', schema: 'public', table };
    if (establishmentId) spec.filter = `establishment_id=eq.${establishmentId}`;
    channel = channel.on('postgres_changes', spec, (payload) => {
      if (table === 'orders' && payload.eventType === 'INSERT') onNewOrder?.(payload.new);
      fire();
    });
  }

  const startPolling = () => { if (!pollTimer) pollTimer = setInterval(onChange, 20_000); };
  const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      stopPolling();
      onStatus?.('online');
      onChange(); // ressincroniza ao (re)conectar
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      onStatus?.('offline');
      startPolling();
    }
  });

  // Ao voltar de segundo plano / reconectar a rede, atualiza na hora
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fire(); });
  window.addEventListener('online', fire);

  return () => { stopPolling(); sb.removeChannel(channel); };
}

/** Bipe curto via Web Audio (sem arquivo de som). */
let audioCtx;
export function beep({ freq = 880, ms = 180, times = 2 } = {}) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const start = audioCtx.currentTime + i * (ms / 1000 + 0.12);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + ms / 1000 + 0.05);
    }
  } catch { /* navegador sem áudio */ }
}
