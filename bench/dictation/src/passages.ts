// What the owner reads aloud for each clip: dictation of the kind OpenBot gets (instructions to a bot), sized for
// about 10, 30 and 60 seconds at a normal reading pace. No digits, so "nine" vs "9" doesn't skew the word error rate.

export type Lang = 'en' | 'fr'

export type Clip = { id: string; lang: Lang; seconds: 10 | 30 | 60; text: string }

export const clips: Clip[] = [
  {
    id: 'en-10',
    lang: 'en',
    seconds: 10,
    text: 'Can you remind me to call the dentist tomorrow morning, and please add milk, eggs and coffee to the shopping list for Saturday?',
  },
  {
    id: 'en-30',
    lang: 'en',
    seconds: 30,
    text:
      'I need you to go through my inbox and find the email from Sarah about the quarterly budget review. Summarize the main ' +
      'points in a few sentences, then draft a polite reply saying I can meet on Thursday afternoon but not on Friday. Keep ' +
      'the tone friendly but professional, and do not send anything until I have read the draft. If there is an attachment, ' +
      'save it to the shared folder as well.',
  },
  {
    id: 'en-60',
    lang: 'en',
    seconds: 60,
    text:
      'Let us plan the trip to Lisbon next month. First, look for flights that leave on a Friday evening and come back on ' +
      'Monday morning, and avoid anything with a long layover. I would rather pay a little more for a direct flight. Then ' +
      'find a small hotel in Alfama or near the river, somewhere quiet with good reviews and breakfast included. Check ' +
      'whether the museums we talked about are open on Sunday, and book a table for dinner on Saturday at a place that ' +
      'serves grilled fish. Put everything in a short document with the prices, the links and the cancellation rules, and ' +
      'share it with Julia so she can add her own ideas. When you are done, send me a summary in this chat, and remind me ' +
      'a week before we leave to check the weather and print the boarding passes.',
  },
  {
    id: 'fr-10',
    lang: 'fr',
    seconds: 10,
    text: "Rappelle-moi d'appeler le dentiste demain matin, et ajoute du lait, des œufs et du café à la liste de courses pour samedi.",
  },
  {
    id: 'fr-30',
    lang: 'fr',
    seconds: 30,
    text:
      "J'aimerais que tu parcoures ma boîte de réception pour retrouver le message de Claire au sujet de la réunion " +
      'budgétaire. Résume les points principaux en quelques phrases, puis prépare une réponse polie pour lui dire que je ' +
      "suis disponible jeudi après-midi, mais pas vendredi. Garde un ton cordial et professionnel, et n'envoie rien avant " +
      "que j'aie relu le brouillon.",
  },
  {
    id: 'fr-60',
    lang: 'fr',
    seconds: 60,
    text:
      "Organisons le voyage à Lisbonne le mois prochain. D'abord, cherche des vols qui partent un vendredi soir et qui " +
      "reviennent le lundi matin, en évitant les longues escales. Je préfère payer un peu plus cher pour un vol direct. " +
      "Ensuite, trouve un petit hôtel dans l'Alfama ou près du fleuve, un endroit calme avec de bons avis et le petit " +
      "déjeuner compris. Vérifie si les musées dont on a parlé sont ouverts le dimanche, et réserve une table pour le dîner " +
      'du samedi dans un restaurant de poisson grillé. Mets tout dans un court document avec les prix, les liens et les ' +
      "conditions d'annulation, et partage-le avec Julia pour qu'elle ajoute ses idées. Quand tu as fini, envoie-moi un " +
      'résumé dans cette conversation.',
  },
]
