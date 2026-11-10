import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { errorMessage } from '../lib/errors.ts'
import { radii, text, useColors } from '../lib/theme.ts'

/** A name to ask for: what it's for, its current value, and what saving does (an error keeps the dialog open). */
export type PromptRequest = {
  title: string
  initial?: string
  placeholder?: string
  maxLength?: number
  confirm: string
  /** Whether a blank name can be saved (a group named after its members). */
  allowBlank?: boolean
  save: (value: string) => Promise<void>
}

/**
 * A text alert, as iOS's: a title, one field, Cancel and the action. Alert.prompt is iOS-only, so both platforms
 * draw this one. Saving waits for `save`; its error shows under the field.
 */
export function Prompt({ request, onClose }: { request: PromptRequest | undefined; onClose: () => void }) {
  return (
    <Modal visible={!!request} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      {/* Keyed by the request, so each one starts from its own value. */}
      {request && <PromptCard key={requestKey(request)} request={request} onClose={onClose} />}
    </Modal>
  )
}

const keys = new WeakMap<PromptRequest, number>()
let lastKey = 0
function requestKey(request: PromptRequest): number {
  let key = keys.get(request)
  if (key === undefined) keys.set(request, (key = ++lastKey))
  return key
}

function PromptCard({ request, onClose }: { request: PromptRequest; onClose: () => void }) {
  const colors = useColors()
  const [value, setValue] = useState(request.initial ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const trimmed = value.trim()
  const canSave = !saving && (!!trimmed || !!request.allowBlank)
  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(undefined)
    try {
      await request.save(trimmed)
      onClose()
    } catch (caught) {
      setError(errorMessage(caught))
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.scrim, { backgroundColor: colors.scrim }]}>
        <View style={[styles.card, { backgroundColor: colors.popover }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>{request.title}</Text>
          <TextInput
            autoFocus
            value={value}
            onChangeText={setValue}
            placeholder={request.placeholder}
            placeholderTextColor={colors.faint}
            maxLength={request.maxLength}
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            editable={!saving}
            accessibilityLabel={request.title}
            style={[styles.field, text.lg, { color: colors.foreground, backgroundColor: colors.inputFill, borderColor: error ? colors.destructive : colors.input }]}
          />
          {error ? <Text style={[text.base, { color: colors.destructiveForeground }]}>{error}</Text> : null}
          <View style={styles.buttons}>
            <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.selected : colors.secondary }]}>
              <Text style={[styles.buttonLabel, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave, busy: saving }}
              disabled={!canSave}
              onPress={() => void save()}
              style={({ pressed }) => [styles.button, { backgroundColor: colors.primary, opacity: !canSave && !saving ? 0.5 : pressed ? 0.8 : 1 }]}
            >
              {saving ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.buttonLabel, { color: colors.primaryForeground }]}>{request.confirm}</Text>
              )}
            </Pressable>
          </View>
        </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  card: { borderRadius: radii.xl, padding: 20, gap: 12, width: '100%', maxWidth: 360, alignSelf: 'center' },
  title: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  field: { height: 44, borderRadius: radii.lg, borderWidth: 1, paddingHorizontal: 12 },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { flex: 1, height: 44, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  buttonLabel: { fontSize: 15, fontWeight: '600' },
})
