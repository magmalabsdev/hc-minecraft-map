Build a website for mapping minecraft server roads and highways

If possible, figure out a way to pull a map from this website https://mc.hackclub.com/ which uses bluemap, If not, use or build a seed terrain predictor and render the terrain as the background

main server plugin:
https://github.com/hackclub/HCCore

server modpack:
https://github.com/hackclub/modpack

MAP MODE:
If not, use or build a seed terrain predictor and render the terrain as the background


The map should have the following types
- Terrain 3D
- Terrain 2D (contour lines toggleable)
- Minimal 2D (contour lines toggleable)

with the following overlays toggleable
- Highway
- Railway 
- Landmark



EDIT MODE:
edit mode should be accessible only when running locally to edit the map. 
This should allow for editing the highway, metro, and landmark map. 



Highway map:
Each highway is drawn by clicking points on the map to draw lines. Clicking an existing point connects a highway to that point. Clicking a point should show its coordinates in the inspector and allow for dragging or editing values to move. Highways can be loops or lines but they cannot be a loop plus spurs. 

Each highway route contains a name, width, whether or not it is flat, whether or not it is lit up, and disruption status with each individual segment having a possibly different value for each. Multiple routes can use the same segment as part of its roadway and a disruption on that segment shows up as a disruption on all routes. Disruptions are values that deviate from the standard values of the road that can be entered next to the standard value and paths with active disruptions will be marked in a different color as well as updated to show its disrupted value

Railway map:
Railways are drawn using the same method as highways with the additional option to place stations. Railways can likewise be loops or lines but not a loop with spurs. Stations can be added by clicking points to draw a polygon and assigning it to one or more railway lines. 


Landmark map:
Landmarks are drawn using the same method for drawing stations and have a name, color, shape, and icon from a list of preselected ones with the default being a map icon. 
Railway stations are a subset of landmarks and show up with their line color and a train icon on the landmark map


Route finding:
Offer route finding services for walking, railway, and horse riding between landmarks. 
For walking, attempt to deviate from roadway every certain number of blocks and proceed in a direct path to the next point and reject the deviation if the terrain does not allow for a smooth journey
For railway, calculate railway times using standard minecart top speed
For horse riding, prefer the roadway unless in flat biomes in which case attempt to deviate from the roadway in the same way walking does

