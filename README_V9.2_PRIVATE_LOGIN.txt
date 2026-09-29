V9.2 — Page de connexion

La première page demande un mot de passe avant d'afficher l'interface.
Le projet contient un emplacement PASSWORD_HASH à remplacer par le hash SHA-256
de votre mot de passe.

IMPORTANT :
Cette protection côté navigateur est une première barrière d'interface.
Pour une vraie protection contre l'accès externe, l'authentification doit aussi
être vérifiée côté serveur avant les routes de génération/API.
Ne mettez jamais le mot de passe en clair dans le code.
