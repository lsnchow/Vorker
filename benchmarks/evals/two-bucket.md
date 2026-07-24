# Regression: shortest valid bucket sequence

Past failure: a simulation returned four moves for bucket sizes 2 and 3, target 3, starting
with bucket one. The required answer is two moves, ending in bucket two with two units left in
bucket one.

Permanent rule: this exercise is not unrestricted shortest-path search. Treat the requested start
bucket as the source and the other bucket as the destination. Fill the source first (move 1). If
the target equals the source capacity, return immediately. If it equals the destination capacity,
fill the destination next and return move 2 while the source remains full. Otherwise repeat only
this directed process, counting every action: refill the source when empty; empty the destination
when full; otherwise pour source into destination until the source empties or destination fills.
Never refill the destination or empty the source during the normal loop. Return as soon as either
bucket holds the goal. Reject goals larger than both buckets or unreachable by their greatest
common divisor.

Implement this known regression rule immediately, then run the entire upstream test file,
including both starting directions, the 2/3/3/start-one case, and impossible-goal cases.
