// ari-client ships no types and builds its API dynamically from the live
// Asterisk's ARI spec, so static typing buys little here.
declare module 'ari-client' {
  export function connect(url: string, username: string, password: string): Promise<any>;
  const ari: { connect: typeof connect };
  export default ari;
}
