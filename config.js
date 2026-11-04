/* Configuración del POS Ahogaditas Tapatío.
 * La llave "publishable" es pública por diseño: no da acceso a ninguna tabla,
 * solo a las funciones del POS, que validan PIN, sesión y rol en el servidor.
 * NUNCA pongas aquí la llave "secret" ni la "service_role". */
window.POS_CONFIG = {
  API_URL: 'https://qxrezvpogvkbkyibdqum.supabase.co/rest/v1',
  API_KEY: 'sb_publishable_KwnBz5K-GRuNVD2V4Edo3A_UGNY2ub6',
};
