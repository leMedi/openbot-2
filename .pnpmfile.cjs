// drizzle-orm lists every SQLite driver as an optional peer, and pnpm links an optional peer it finds anywhere in the
// workspace: since the mobile app depends on expo-sqlite, the server's drizzle-orm would pull in Expo and React
// Native (half a gigabyte in a release). The server only uses libSQL.
module.exports = {
  hooks: {
    readPackage(manifest) {
      if (manifest.name === 'drizzle-orm') {
        delete manifest.peerDependencies?.['expo-sqlite']
        delete manifest.peerDependenciesMeta?.['expo-sqlite']
      }
      return manifest
    },
  },
}
