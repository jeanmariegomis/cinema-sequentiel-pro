V9.1 — Clé API Agnes AI dans l'interface

Le champ « Clé API Agnes AI » est ajouté à l'interface.
La clé est envoyée au serveur dans l'en-tête X-Agnes-API-Key.
Le serveur utilise cette clé pour la requête courante et utilise AGNES_API_KEY
comme valeur de secours si aucune clé n'est fournie par l'interface.

Pour la sécurité, ne partagez jamais votre clé API dans une capture ou un dépôt public.
