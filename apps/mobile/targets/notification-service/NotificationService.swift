import Intents
import UIKit
import UserNotifications

/// What OpenBot's push carries (PushData in @openbot/api-contract), under Expo's `body` key.
struct OpenBotPush {
  let chatId: String
  let botId: String
  let botName: String
  let group: Bool
  let quiet: Bool

  init?(userInfo: [AnyHashable: Any]) {
    guard let data = userInfo["body"] as? [String: Any],
      let chatId = data["chatId"] as? String,
      let botName = data["botName"] as? String
    else { return nil }
    self.chatId = chatId
    self.botId = data["botId"] as? String ?? ""
    self.botName = botName
    self.group = data["group"] as? Bool ?? false
    self.quiet = data["quiet"] as? Bool ?? false
  }
}

/// Makes OpenBot's pushes communication notifications (spec: Notifications on the phone → Avatar): the bot's avatar on
/// the left with the app's icon as a badge, and a group chat's name with the speaking bot's avatar. The avatar comes from
/// the app's own cache in the app group (avatars/<botId>.png, kept by the app as bots change), never downloaded here, so
/// it shows offline too; a bot not cached yet gets its initials. A quiet push (a later message of the same turn,
/// replacing the chat's line) is passive: no banner, no sound, the screen left dark. Anything else, or a failure, shows
/// the push as it came.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?
  /// The handler is called once: by the drawing (on the donation's queue) or as time runs out, whichever comes first.
  private let lock = NSLock()

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    original = request.content
    CommunicationNotification.make(from: request.content) { self.finish($0) }
  }

  override func serviceExtensionTimeWillExpire() {
    if let original { finish(original) }
  }

  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let handler = contentHandler
    contentHandler = nil
    lock.unlock()
    handler?(content)
  }
}

enum CommunicationNotification {
  /// `content` as a communication notification from its bot, or as it came when it isn't OpenBot's.
  static func make(from content: UNNotificationContent, completion: @escaping (UNNotificationContent) -> Void) {
    guard let push = OpenBotPush(userInfo: content.userInfo),
      let content = content.mutableCopy() as? UNMutableNotificationContent
    else { return completion(content) }
    // Passive as it came (push.ts sends it so), and kept so should the update below fail.
    if push.quiet { content.interruptionLevel = .passive }

    let sender = INPerson(
      personHandle: INPersonHandle(value: push.botId, type: .unknown),
      nameComponents: nil,
      displayName: push.botName,
      image: avatar(of: push),
      contactIdentifier: nil,
      customIdentifier: push.botId
    )
    // iOS shows a conversation as a group when it has a name and more than one other person in it.
    let owner = INPerson(
      personHandle: INPersonHandle(value: "owner", type: .unknown), nameComponents: nil, displayName: nil, image: nil,
      contactIdentifier: nil, customIdentifier: nil, isMe: true, suggestionType: .none)
    // In a group, iOS names the bot above the group's name, so the body's "Rex: " goes; it stays should this fail.
    let prefix = "\(push.botName): "
    let body = push.group && content.body.hasPrefix(prefix) ? String(content.body.dropFirst(prefix.count)) : content.body
    let intent = INSendMessageIntent(
      recipients: push.group ? [owner, sender] : nil,
      outgoingMessageType: .outgoingMessageText,
      content: body,
      speakableGroupName: push.group ? INSpeakableString(spokenPhrase: content.title) : nil,
      conversationIdentifier: push.chatId,
      serviceName: nil,
      sender: sender,
      attachments: nil
    )
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { _ in
      guard let updated = (try? content.updating(from: intent))?.mutableCopy() as? UNMutableNotificationContent else {
        return completion(content)
      }
      updated.body = body
      if push.quiet { updated.interruptionLevel = .passive }
      completion(updated)
    }
  }

  /// The bot's avatar from the app's cache, or its initials.
  static func avatar(of push: OpenBotPush) -> INImage? {
    if let file = avatarFile(botId: push.botId), let data = try? Data(contentsOf: file) {
      return INImage(imageData: data)
    }
    return initials(of: push.botName).flatMap { INImage(imageData: $0) }
  }

  /// The app group the app shares with this extension, from its Info.plist (plugins/notification-service.ts).
  static var appGroup: String? { Bundle.main.object(forInfoDictionaryKey: "OpenBotAppGroup") as? String }

  /// Where the app keeps a bot's avatar: its id as encodeURIComponent writes it (avatars.ts).
  static func avatarFile(botId: String) -> URL? {
    guard !botId.isEmpty, let appGroup,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return nil }
    let unreserved = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    guard let name = botId.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
    return container.appendingPathComponent("avatars").appendingPathComponent("\(name).png")
  }

  /// The bot's initials (up to two) in white on gray, as a PNG; nil for a name without letters.
  static func initials(of name: String) -> Data? {
    let letters = name.split(whereSeparator: { $0.isWhitespace }).prefix(2).compactMap { $0.first }.map { String($0).uppercased() }
    guard !letters.isEmpty else { return nil }
    let size = CGSize(width: 192, height: 192)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      UIColor(red: 0.45, green: 0.45, blue: 0.45, alpha: 1).setFill()
      context.fill(CGRect(origin: .zero, size: size))
      let text = letters.joined() as NSString
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 80, weight: .semibold), .foregroundColor: UIColor.white,
      ]
      let box = text.size(withAttributes: attributes)
      text.draw(at: CGPoint(x: (size.width - box.width) / 2, y: (size.height - box.height) / 2), withAttributes: attributes)
    }
    return image.pngData()
  }
}
