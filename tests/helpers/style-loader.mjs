// Node SSR tests inspect markup; plain side-effect styles are handled by Vite
// in the application and have no module value to evaluate in these tests.
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  return nextLoad(url, context);
}
