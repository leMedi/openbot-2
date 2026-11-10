// Expo's Metro config as it is. It sets up the monorepo itself: it watches the workspace and follows pnpm's symlinks,
// so the workspace packages, raw TypeScript with `.ts`-suffixed imports, resolve and transform as the app's own. Its
// autolinking resolver also takes react, react-dom and react-native from the app wherever they're imported, so the
// workspace packages, whose own react is the webapp's version, don't put a second React in the bundle (checked with
// `expo export`: one react@19.3.0).
const { getDefaultConfig } = require('expo/metro-config')

module.exports = getDefaultConfig(__dirname)
