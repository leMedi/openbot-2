package expo.modules.notificationsnative

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationAction
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.NotificationResponse
import expo.modules.notifications.notifications.presentation.builders.ExpoNotificationBuilder
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.delegates.SharedPreferencesNotificationCategoriesStore
import expo.modules.notifications.service.interfaces.PresentationDelegate
import org.json.JSONObject

/**
 * expo-notifications' dispatcher, drawing OpenBot's notifications (those whose data the instance sent: a chat, a
 * message and a kind) as conversations; any other notification is drawn as expo-notifications draws it.
 */
class ConversationNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate = ConversationPresentationDelegate(context)
}

/** What a push can be for, as `pushKinds` in @openbot/api-contract. */
private val PUSH_KINDS = setOf("message", "question", "take_over", "plugin_request", "plugin_reconnect")

/** An OpenBot notification's data, as the instance sends it (PushData in @openbot/api-contract). */
internal data class PushData(
  val chatId: String,
  val kind: String,
  val botId: String,
  val botName: String,
  val group: Boolean,
  val quiet: Boolean,
) {
  companion object {
    fun of(notification: Notification): PushData? {
      val body: JSONObject = notification.notificationRequest.content.body ?: return null
      val chatId = body.optString("chatId")
      val kind = body.optString("kind")
      if (chatId.isEmpty() || kind !in PUSH_KINDS || body.optString("messageId").isEmpty()) return null
      return PushData(chatId, kind, body.optString("botId"), body.optString("botName"), body.optBoolean("group"), body.optBoolean("quiet"))
    }
  }
}

/** The channels the phone's notifications go to, as `makeChannels` (src/lib/notifications/phone.ts) makes them: a bot's messages, and a card waiting. */
internal const val MESSAGES_CHANNEL = "messages"
internal const val NEEDS_YOU_CHANNEL = "needs-you"

/** How many of a chat's messages its notification keeps showing. */
private const val KEPT_MESSAGES = 6

/** The identifier, so the tag, of a chat's one notification: a later one replaces it. */
internal fun chatTag(chatId: String) = "openbot-chat-$chatId"

class ConversationPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  /** One notification per chat: it's presented under the chat's tag, whatever its push identifier was. */
  override fun presentNotification(notification: Notification, behavior: NotificationBehaviorRecord?) {
    val data = PushData.of(notification) ?: return super.presentNotification(notification, behavior)
    val request = notification.notificationRequest
    val tagged = Notification(NotificationRequest(chatTag(data.chatId), request.content, request.trigger), notification.originDate)
    super.presentNotification(tagged, behavior)
  }

  override suspend fun createNotification(notification: Notification, notificationBehavior: NotificationBehaviorRecord?): android.app.Notification {
    val data = PushData.of(notification) ?: return super.createNotification(notification, notificationBehavior)
    return ConversationNotificationBuilder(context, notification, data).apply { setAllowedBehavior(notificationBehavior) }.build()
  }
}

/**
 * A chat's notification as a conversation (MessagingStyle): the bot as the sender, the group's name as the
 * conversation's title in a group, and the chat's earlier messages still showing kept above the new one. A quiet push
 * (a later message of the same turn) updates it without a sound ("alert once"); the next turn's first message, or a
 * card, alerts again.
 */
internal class ConversationNotificationBuilder(
  context: Context,
  notification: Notification,
  private val data: PushData,
) : ExpoNotificationBuilder(context, notification, SharedPreferencesNotificationCategoriesStore(context)) {
  override suspend fun build(): android.app.Notification {
    val content = notification.notificationRequest.content
    ensureChannels(context)
    val channel = if (data.kind == "message") MESSAGES_CHANNEL else NEEDS_YOU_CHANNEL
    val title = content.title ?: data.botName
    val sender = Person.Builder().setName(data.botName.ifEmpty { title }).setKey(data.botId.ifEmpty { null }).build()
    val text = (content.text ?: "").let { if (data.group && it.startsWith("${data.botName}: ")) it.removePrefix("${data.botName}: ") else it }

    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").setKey("owner").build())
    if (data.group) {
      style.conversationTitle = title
      style.isGroupConversation = true
    }
    // The chat's notification still showing: its messages stay, the new one under them.
    val tag = notification.notificationRequest.identifier
    NotificationManagerCompat.from(context).activeNotifications
      .firstOrNull { it.tag == tag }
      ?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification) }
      ?.messages
      ?.takeLast(KEPT_MESSAGES - 1)
      ?.forEach { style.addMessage(it) }
    style.addMessage(text, notification.originDate.time, sender)

    val quiet = data.quiet || notificationBehavior?.shouldPlaySound == false
    val builder = NotificationCompat.Builder(context, channel)
      .setSmallIcon(R.drawable.openbot_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(style)
      .setCategory(if (data.kind == "message") NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setWhen(notification.originDate.time)
      .setShowWhen(true)
      .setOnlyAlertOnce(quiet)
      .setSilent(quiet)
    content.badgeCount?.toInt()?.let { builder.setNumber(it) }

    // What expo-notifications keeps on its own notifications: the data, and the request, read back for the JS side
    // (presented notifications, the tap's response).
    content.body?.let { builder.extras.putString(EXTRAS_BODY_KEY, it.toString()) }
    marshallNotificationRequest(notification.notificationRequest)?.let { builder.extras.putByteArray(EXTRAS_MARSHALLED_NOTIFICATION_REQUEST_KEY, it) }
    builder.setContentIntent(
      NotificationsService.createNotificationResponseIntent(
        context,
        notification,
        NotificationAction(NotificationResponse.DEFAULT_ACTION_IDENTIFIER, null, true),
      ),
    )
    return builder.build()
  }
}

/** Makes the two channels if the app's JS hasn't yet (it makes them before asking for the permission). */
internal fun ensureChannels(context: Context) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
  val manager = context.getSystemService(NotificationManager::class.java) ?: return
  if (manager.getNotificationChannel(MESSAGES_CHANNEL) == null) {
    manager.createNotificationChannel(NotificationChannel(MESSAGES_CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH))
  }
  if (manager.getNotificationChannel(NEEDS_YOU_CHANNEL) == null) {
    manager.createNotificationChannel(NotificationChannel(NEEDS_YOU_CHANNEL, "When a bot needs you", NotificationManager.IMPORTANCE_HIGH))
  }
}
