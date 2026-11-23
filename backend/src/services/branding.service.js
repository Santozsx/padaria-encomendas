// Identidade visual de cada loja: cores e logo.
// A logo chega em base64 (a tela já reduz a imagem antes de enviar),
// é conferida aqui (tipo real do arquivo + tamanho) e guardada no banco.
import { AppError, unwrap } from '../lib/errors.js';
import { brandInfo, normalizeHex } from '../lib/brand.js';

export const LOGO_MAX_BYTES = 512 * 1024;

/** Confere pelos primeiros bytes se o arquivo é mesmo PNG, JPEG ou WebP. */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** base64 (com ou sem "data:image/...;base64,") → Buffer validado. */
export function decodeLogo(input) {
  const raw = String(input || '').replace(/^data:image\/[a-z+]+;base64,/i, '').replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new AppError(422, 'LOGO_INVALIDA', 'Não consegui ler a imagem da logo.');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > LOGO_MAX_BYTES) throw new AppError(422, 'LOGO_GRANDE', 'A logo é grande demais (máximo 512 KB).');
  const mime = sniffImage(buf);
  if (!mime) throw new AppError(422, 'LOGO_FORMATO', 'Use uma imagem PNG, JPG ou WebP.');
  return { buf, mime };
}

export function createBrandingService(db, { settings }) {
  // cache da imagem em memória: { at(versão), mime, buf }
  const cache = new Map();

  function ensureReady() {
    if (settings.brandingReady && !settings.brandingReady()) {
      throw new AppError(409, 'RODE_MIGRACAO', 'Falta rodar o arquivo supabase/migrations/009_identidade_visual.sql no Supabase.');
    }
  }

  /** Cores + logo da loja, no formato das telas. */
  async function get(estId) {
    return brandInfo(await settings.get(estId));
  }

  /**
   * Salva a aparência. Campos ausentes ficam como estão.
   * @param {{brand_color?:string|null, brand_color_2?:string|null, logo?:string, remove_logo?:boolean}} input
   */
  async function save(estId, input) {
    await settings.get(estId); // lê a loja (e descobre se o banco tem as colunas)
    ensureReady();
    const patch = {};
    if ('brand_color' in input) patch.brand_color = normalizeHex(input.brand_color);
    if ('brand_color_2' in input) patch.brand_color_2 = normalizeHex(input.brand_color_2);

    if (input.logo) {
      const { buf, mime } = decodeLogo(input.logo);
      const now = new Date().toISOString();
      unwrap(await db.from('establishment_logos').upsert(
        { establishment_id: estId, mime, data_base64: buf.toString('base64'), updated_at: now },
        { onConflict: 'establishment_id' },
      ));
      patch.logo_updated_at = now;
      cache.delete(estId);
    } else if (input.remove_logo) {
      unwrap(await db.from('establishment_logos').delete().eq('establishment_id', estId));
      patch.logo_updated_at = null;
      cache.delete(estId);
    }

    if (Object.keys(patch).length) {
      unwrap(await db.from('establishments').update(patch).eq('id', estId));
    }
    settings.invalidate(estId);
    return get(estId);
  }

  /** A imagem da logo (para a rota pública). null = loja sem logo. */
  async function logo(est) {
    if (!est.logoUpdatedAt) return null;
    const version = new Date(est.logoUpdatedAt).getTime();
    const hit = cache.get(est.id);
    if (hit && hit.at === version) return hit;
    const { data, error } = await db.from('establishment_logos').select('mime, data_base64').eq('establishment_id', est.id).maybeSingle();
    if (error) unwrap({ error });
    if (!data) return null;
    const entry = { at: version, mime: data.mime, buf: Buffer.from(data.data_base64, 'base64') };
    cache.set(est.id, entry);
    return entry;
  }

  return { get, save, logo };
}
