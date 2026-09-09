# Ebooks: several books in one directory

The Audiobookshelf data model comes from audiobooks: **one book = one directory**.
That does not work for ebooks. A directory often holds several books by one author
or a whole series, and Audiobookshelf turned them into a single item where one file
was the "main" one and the others were only additional formats.

This fork adds the library setting **"Split folders with multiple ebooks into
separate books"** (`splitEbooksByFile`). It is **on by default**, also for libraries
created before this change; it can be turned off in the library settings.

## How the scanner decides

A directory is split into separate books when **it contains no audio file directly**
and at the same time

- it holds **two or more ebooks with different file names**, or
- it holds **one ebook plus more ebooks in subdirectories** (an author directory with
  a loose book next to a series folder is a "shelf", not a book).

What stays together as one book: files with the **same name without extension** in
the same directory. `Book.epub` + `Book.pdf` + `Book.mobi` (epub is the primary file,
the others are additional formats) together with `Book.opf`, `Book.jpg`, `Book.nfo`.
A file that matches no book (a shared `cover.jpg`, `desc.txt`) is attached to none of
them; otherwise the same description would stick to every book.

What does **not** change:

- a directory with audio files stays one audiobook, an ebook next to it is an additional format,
- a directory with a single book (even with several formats and a cover) stays one item,
- ebooks directly in the root of the library folder are still separate items without an author,
- with **Audiobooks only** enabled, ebooks are ignored as before.

## Metadata of split books

The path is parsed the same way as for directories, `/author/series/title/`, only the
file name takes the place of the book folder:

| Path | Author | Series | Title |
| --- | --- | --- | --- |
| `Karel Čapek/Válka s mloky.epub` | Karel Čapek | – | Válka s mloky |
| `Karel Čapek/Trilogie/2 - Povětroň.epub` | Karel Čapek | Trilogie, book 2 | Povětroň |

Note: for `Author/Book title/Second book.epub` the middle folder is taken as the series,
exactly as for directories. The recommended structure for ebooks is therefore flat:
`Author/Title.epub` or `Author/Title/Title.epub`.

Metadata from an `.opf` next to the file and from the OPF inside the epub take
precedence over file names (source order in the library scanner settings), so
`calibre:series` from a Calibre export works. The cover comes from the image with the
same name, otherwise from the epub. Because the item is a file and not a directory,
`metadata.json` and `cover.jpg` are stored in `/metadata/items/<id>/`, not next to the
book; two books in one directory would overwrite each other's files.

## What to expect when enabling it on an existing library

A directory that used to be one item falls apart into separate books on the next scan.
One of them takes over the original item (including the reading progress), the others
are created as new items. When you turn the setting off again, the books merge back and
the surplus items remain marked as **missing**; "Remove items with issues" in the
library settings cleans them up.

The folder watcher handles adding and deleting a book in a split directory at runtime.
When a single book is left in the directory after a deletion, the directory becomes one
item again (taken over by the remaining book).

## Calibre: when and when not

With this setting it is **not necessary to reorganize the library through Calibre**
for Audiobookshelf to see every book. That has two major advantages:

- no files are copied, so the items keep their identity (matched by path and inode),
  reading progress, bookmarks and collections stay,
- nothing is uploaded again on an rclone/Google Drive mount.

Calibre makes sense as an **optional step to complete the metadata** (`calibredb add -r`
→ fix the metadata → `calibredb export`). Then expect that:

1. the export is a **copy**: new inodes, new items, loss of reading progress, bookmarks,
   collections and statistics (the server deletes orphaned progress at startup),
2. `calibredb export` without `--dont-asciiize` strips diacritics from the names,
3. `calibredb add` without `--duplicates` silently skips books with the same title and author,
4. Calibre does not read `doc`, `docx`, `rtf` and `pdb` well and guesses the metadata from the file name,
5. companion files (`.nfo`, `desc.txt`, other images) are not carried over by the export.

Use `{authors}/{title}/{title}` as the export template (not `{author_sort}`, even though
the parser can handle it) and `--dont-asciiize`. The output `Author/Title/Title.epub` +
`metadata.opf` + `cover.jpg` is read correctly by Audiobookshelf.

Where to run Calibre: once, in a container on the server where the library lives, not
as a permanent service in the stack and not by moving the library to a desktop and back:

```bash
docker run --rm -v /opt/audio/audiobooks:/books:ro -v /tmp/calibre:/lib \
  linuxserver/calibre calibredb add -r /books --library-path /lib --duplicates
```
