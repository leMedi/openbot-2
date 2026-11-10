/// <reference types="node" />
// iOS's communication notifications (spec: Notifications on the phone → Avatar): a Notification Service Extension
// that draws OpenBot's pushes with the bot's avatar, read from the app group the app keeps its bots' avatars in.
import { type ConfigPlugin, withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject, type XcodeProject } from 'expo/config-plugins'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The extension's target, folder and product name in the Xcode project. */
const target = 'NotificationService'
/** Its Swift source, kept in the repo (ios/ is generated), in targets/notification-service. */
const sources = ['NotificationService.swift']

const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`

const infoPlist = (appGroup: string) =>
  plist(`  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>${target}</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>OpenBotAppGroup</key>
  <string>${appGroup}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>`)

const entitlements = (appGroup: string) =>
  plist(`  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>`)

/**
 * The app: the app group, the communication notifications capability and the send-message intent it donates. The
 * extension: its target (built and embedded with the app), its Info.plist naming the app group, and its entitlements.
 * Pushes reach it as they're sent with mutableContent (apps/webapp's push.ts).
 */
export const withNotificationService: ConfigPlugin<{ appGroup: string }> = (config, { appGroup }) => {
  config = withEntitlementsPlist(config, (config) => {
    const groups = (config.modResults['com.apple.security.application-groups'] as string[] | undefined) ?? []
    config.modResults['com.apple.security.application-groups'] = [...new Set([...groups, appGroup])]
    config.modResults['com.apple.developer.usernotifications.communication'] = true
    return config
  })
  config = withInfoPlist(config, (config) => {
    const types = (config.modResults.NSUserActivityTypes as string[] | undefined) ?? []
    config.modResults.NSUserActivityTypes = [...new Set([...types, 'INSendMessageIntent'])]
    return config
  })
  config = withDangerousMod(config, [
    'ios',
    (config) => {
      const folder = join(config.modRequest.platformProjectRoot, target)
      mkdirSync(folder, { recursive: true })
      for (const source of sources) copyFileSync(join(config.modRequest.projectRoot, 'targets', 'notification-service', source), join(folder, source))
      writeFileSync(join(folder, `${target}-Info.plist`), infoPlist(appGroup))
      writeFileSync(join(folder, `${target}.entitlements`), entitlements(appGroup))
      return config
    },
  ])
  return withXcodeProject(config, (config) => {
    const project = config.modResults
    const bundleId = config.ios?.bundleIdentifier
    if (!bundleId) throw new Error('notification-service: the app has no iOS bundle identifier')
    // A prebuild over an existing project only brings the target's settings up to date.
    if (!project.pbxTargetByName(target)) addTarget(project, bundleId)
    updateSettings(project, bundleId)
    return config
  })
}

/** Adds the extension's target, built and embedded with the app, with its files in a group of their own. */
function addTarget(project: XcodeProject, bundleId: string) {
  const group = project.addPbxGroup([...sources, `${target}-Info.plist`, `${target}.entitlements`], target, target)
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)
  // node-xcode adds a target dependency, which needs these sections to exist.
  const objects = project.hash.project.objects
  objects.PBXTargetDependency ??= {}
  objects.PBXContainerItemProxy ??= {}
  const extension = project.addTarget(target, 'app_extension', target, `${bundleId}.${target}`)
  project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', extension.uuid)
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', extension.uuid)
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', extension.uuid)
}

type BuildConfigurations = Record<string, { name?: string; buildSettings?: Record<string, string | undefined> }>

/** The extension's build settings, with the app's own it must share: its deployment target, versions and team. */
function updateSettings(project: XcodeProject, bundleId: string) {
  const configurations = project.pbxXCBuildConfigurationSection() as BuildConfigurations
  const unquoted = (value: string | undefined) => value?.replace(/^"|"$/g, '')
  const app =
    Object.values(configurations).find((each) => each.name === 'Release' && unquoted(each.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER) === bundleId)
      ?.buildSettings ?? {}
  for (const { buildSettings: settings } of Object.values(configurations)) {
    if (!settings || unquoted(settings.PRODUCT_NAME) !== target) continue
    Object.assign(settings, {
      CODE_SIGN_ENTITLEMENTS: `${target}/${target}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      IPHONEOS_DEPLOYMENT_TARGET: app.IPHONEOS_DEPLOYMENT_TARGET ?? '16.4',
      MARKETING_VERSION: app.MARKETING_VERSION ?? '1.0',
      CURRENT_PROJECT_VERSION: app.CURRENT_PROJECT_VERSION ?? '1',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '1',
      GENERATE_INFOPLIST_FILE: 'NO',
      ...(app.DEVELOPMENT_TEAM && { DEVELOPMENT_TEAM: app.DEVELOPMENT_TEAM }),
    })
  }
}
