# Store listing localizations

These files contain paste-ready summaries, detailed descriptions, and screenshot
descriptions for Chrome Web Store and Firefox Add-ons.

## Supported locales

| Store locale | Extension locale | File |
| --- | --- | --- |
| English | `en` | `en.txt` |
| French | `fr` | `fr.txt` |
| Spanish | `es` | `es.txt` |
| Portuguese (Brazil) | `pt_BR` | `pt-BR.txt` |
| Indonesian | `id` | `id.txt` |
| Japanese | `ja` | `ja.txt` |
| Vietnamese | `vi` | `vi.txt` |
| Thai | `th` | `th.txt` |

## Upload notes

1. Upload a release package containing the matching `_locales` directories.
2. In Chrome Web Store, select each language from the Store Listing language
   menu and paste its detailed description. Chrome derives the short description
   from the localized manifest.
3. In Firefox Add-ons, add each language under Edit Product Page and paste the
   localized summary, description, and screenshot descriptions.
4. Keep one truthful screenshot set. Firefox supports localized screenshot
   descriptions but only one image set. Chrome can accept locale-specific image
   sets, but the global screenshots are preferable until the complete in-page
   interface is translated.
5. Use these images in this order:
   `assets/screenshot-title.png`, `assets/screenshot-chapters.png`,
   `assets/screenshot-progress.png`.

The copy deliberately identifies the extension as unofficial, avoids rating
incentives and keyword repetition, and discloses the project service used by the
community features and notices.
