// Selector de Google Drive: el usuario elige un archivo puntual con el
// Picker de Google (scope drive.file, mínimo privilegio — la app solo ve lo
// que el usuario elige explícitamente). No se guarda ningún token en el
// servidor: el access token vive solo en memoria del navegador y se pide de
// nuevo cada vez que hace falta.
import { get } from './api';

declare global {
  interface Window { google?: any; gapi?: any }
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let configPromise: Promise<{ googleClientId: string | null; googleApiKey: string | null }> | null = null;
function loadConfig() {
  configPromise ??= get('/api/auth/config');
  return configPromise;
}

let gsiScript: Promise<void> | null = null;
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gsiScript ??= loadScript('https://accounts.google.com/gsi/client');
  return gsiScript;
}

let pickerApi: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  pickerApi ??= loadScript('https://apis.google.com/js/api.js').then(
    () => new Promise((resolve) => window.gapi.load('picker', resolve)));
  return pickerApi;
}

let accessToken: string | null = null;
function requestAccessToken(clientId: string): Promise<string> {
  if (accessToken) return Promise.resolve(accessToken);
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp: { access_token?: string; error?: string }) => {
        if (!resp.access_token) { reject(new Error(resp.error ?? 'No se otorgó acceso a Drive')); return; }
        accessToken = resp.access_token;
        resolve(resp.access_token);
      },
      error_callback: (err: { message?: string }) => reject(new Error(err?.message ?? 'No se otorgó acceso a Drive')),
    });
    client.requestAccessToken();
  });
}

export interface PickedDriveFile {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

// Abre el selector de Drive y resuelve con el archivo elegido, o null si el
// usuario canceló. Lanza si Google Sign-In no está configurado en el server.
export async function pickDriveFile(): Promise<PickedDriveFile | null> {
  const { googleClientId, googleApiKey } = await loadConfig();
  if (!googleClientId || !googleApiKey) {
    throw new Error('La integración con Google Drive no está configurada en el servidor');
  }
  await Promise.all([loadGis(), loadPicker()]);
  const token = await requestAccessToken(googleClientId);

  return new Promise((resolve, reject) => {
    const picker = new window.google.picker.PickerBuilder()
      .addView(window.google.picker.ViewId.DOCS_IMAGES)
      .addView(window.google.picker.ViewId.DOCS_VIDEOS)
      .addView(window.google.picker.ViewId.PDFS)
      .addView(window.google.picker.ViewId.DOCS)
      .setOAuthToken(token)
      .setDeveloperKey(googleApiKey)
      .setCallback((data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({ id: doc.id, name: doc.name, mimeType: doc.mimeType, url: doc.url });
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    try {
      picker.setVisible(true);
    } catch (err) {
      reject(err);
    }
  });
}

// Construye el snippet markdown a insertar según el tipo de archivo elegido.
// Imagen, video y PDF usan el visor embebido de Drive (iframe) reconocido
// por el renderer (ver markdown.ts) — un <img> directo a "uc?export=view"
// no es confiable: depende de la cookie de sesión de Google, que se
// bloquea al pedirse como subrecurso de otro origen (contexto de terceros).
export function driveFileSnippet(file: PickedDriveFile): string {
  const name = file.name.replace(/[\[\]]/g, '');
  const previewUrl = `https://drive.google.com/file/d/${file.id}/preview`;
  if (file.mimeType.startsWith('image/')) return `![image:${name}](${previewUrl})`;
  if (file.mimeType.startsWith('video/')) return `![video:${name}](${previewUrl})`;
  if (file.mimeType === 'application/pdf') return `![pdf:${name}](${previewUrl})`;
  return `[${name}](${file.url})`;
}
