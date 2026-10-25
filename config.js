// Playlist Master – Konfiguration
// Die Client ID ist nicht geheim und darf im Code stehen (PKCE-Login ohne Client Secret).
window.PM_CONFIG = {
  clientId: "908449dafbc64bc19fe67464d466786d",

  // Präfix für die von der App angelegten Playlists
  playlistPrefix: "PM · ",

  // Startlisten je Kategorie (in der App editierbar, Änderungen werden lokal gespeichert)
  categories: {
    "Metal": [
      "Sevendust", "Five Finger Death Punch", "Papa Roach", "In Flames", "Linkin Park",
      "Electric Callboy", "Amaranthe", "System Of A Down", "Slipknot", "Six Feet Under",
      "TOOL", "Rammstein", "Rage Against The Machine", "Opeth", "Nickelback", "Nevermore",
      "Metallica", "Marilyn Manson", "Limp Bizkit", "Life Of Agony", "Kyuss", "Korn",
      "Disturbed", "Apocalyptica", "Die Apokalyptischen Reiter", "Deftones",
      "Bullet For My Valentine", "Architects", "Falling In Reverse", "Spiritbox",
      "Arch Enemy", "While She Sleeps", "Bring Me The Horizon", "ROMES", "Father Of Peace"
    ],
    "Rock": [
      "Coldplay", "Queens of the Stone Age", "Jimmy Eat World", "Die Toten Hosen",
      "Two Steps from Hell", "Farin Urlaub", "Farin Urlaub Racing Team", "Two Door Cinema Club",
      "The Naked And Famous", "The Baseballs", "Sum 41", "Sting", "Sportfreunde Stiller",
      "Rise Against", "Revolverheld", "R.E.M.", "Placebo", "The Offspring", "No Doubt",
      "My Chemical Romance", "Mando Diao", "Less Than Jake", "Lenny Kravitz", "Kraftklub",
      "Incubus", "HIM", "H-Blockx", "Guano Apes", "Green Day", "Good Charlotte",
      "The Goo Goo Dolls", "Garbage", "Fall Out Boy", "Donots", "Die Happy", "Die Ärzte",
      "The Cranberries", "Bush", "Bruce Springsteen", "Böhse Onkelz", "Bloodhound Gang",
      "Billy Talent", "Beatsteaks", "Bad Religion", "Avril Lavigne", "Audioslave",
      "Thirty Seconds To Mars", "3 Doors Down", "Muse", "Red Hot Chili Peppers",
      "Foo Fighters", "Biffy Clyro"
    ],
    "Electro": [
      "The Glitch Mob", "ATB", "Calvin Harris", "Armin van Buuren", "Zedd", "The Prodigy",
      "Swedish House Mafia", "Skrillex", "Pendulum", "M83", "DJ Fresh", "The Chemical Brothers"
    ],
    "Rap & HipHop": [
      "Alligatoah", "Peter Fox", "Genetikk", "K.I.Z", "Seeed", "Kanye West", "Jan Delay",
      "Fettes Brot", "Everlast", "Eminem", "Die Fantastischen Vier", "Dendemann", "Beginner",
      "Samy Deluxe", "Ren"
    ],
    "Softrock & Indie": [
      "The War On Drugs", "Kings of Leon", "Snow Patrol", "Manchester Orchestra",
      "Mumford & Sons", "Of Monsters and Men", "Bear's Den", "Wrest", "Racing Glaciers",
      "Keane", "Brandon Flowers", "Andrew Belle", "White Lies", "The Killers", "Sam Fender",
      "The Sweet Serenades", "Somebody's Child"
    ]
  }
};
