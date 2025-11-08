Requires a mirrored-scene folder to be in Foundry/Data
scene-mirror is the foundry module
this doesn't have all the node modules required so there will need to be some tweaking with it to get it to work correclty.

to do (version 7):
1. change the foundry module to Foundry Lite
2. add folder setup to the Foundry module
3. Bug fix: not all of the config and fow are saved as they should be

----------------------------------------

tldr; Foundry used for image, combat, and player data. Foundry Lite runs player view and DM view.

There are two components - a Foundry Module and the nodejs server.

The Foundry Module does three things - 
when a scene is activated it copies the background image to a folder in the foundry data folder.
When combat is activated it creates a json file of the combat order int eh same folder.
Any changes to character sheets in foundry will save a new player json to the folder.
The Server has 2 HTML pages. One is the player's view and one is the DMs view.

Players page: displays the scene image with fow overlay, list of combatant's in order across the top, highlights the current combatant, and health indicator (healthy, hurt, bloodied, critical, out).

Server page: displays the same image but with tools for fow, highlighting, text, and some configuration (grid size mainly to account for different image sizes).

Since the DM page is also just being HTML I can run it on pretty much any hardware. So in theory, if Diecast has a DM screen that can switch scenes, set combat order, and switch next turn, I could run all without having to use Foundry  for in person games. 
